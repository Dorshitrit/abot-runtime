import { startAgentBridge } from "../../bridge/start-agent-bridge.js";
import { validateRuntimeBridgeConnection, type RuntimeBridgeConnection } from "../../bridge/runtime-connection.js";
import type { RuntimeConfig } from "../ports.js";
import { createSparkChatAccess } from "../spark-chat/service.js";
import { createLocalAgentEvents, createLocalAgentsClient } from "./client-agents.js";
import { createLocalLearningClient } from "./client-learning.js";
import { LocalRuntimeClientRequests } from "./client-requests.js";
import { createLocalServiceClients } from "./client-services.js";
import type { LocalRuntimeOwner, LocalRuntimePeer } from "./contracts.js";

/** A peer of the elected owner, with the same request, approval and session boundaries as local clients. */
function openBridgePeer(config: RuntimeConfig, owner: LocalRuntimeOwner, connection: RuntimeBridgeConnection, preserveIdentity: boolean, hasActivePeer: (peer: LocalRuntimePeer) => boolean) {
  const closeListeners = new Set<() => void>();
  let inFlight = 0;
  let fenced = false;
  let detached = false;
  const call = async (method: string, args: readonly unknown[]) => {
    if (detached) throw new Error("local_runtime_connection_lost");
    if (fenced) throw new Error("socket_connection_busy");
    inFlight++;
    try { return await owner.call(method, args, peer); } finally { inFlight--; }
  };
  const requests = new LocalRuntimeClientRequests(call);
  const peer: LocalRuntimePeer = {
    id: "local-outbound-bridge",
    callClient: (method, args) => requests.handleCallback(method, args),
    onClose(listener) { closeListeners.add(listener); return () => { closeListeners.delete(listener); }; },
  };
  const services = createLocalServiceClients(call);
  const learning = createLocalLearningClient(call);
  const agentEvents = createLocalAgentEvents();
  const agents = createLocalAgentsClient(call);
  const unsubscribe = owner.subscribe(event => {
    requests.receive(event);
    agentEvents.receive(event);
  });
  function closePeer() {
    requests.close();
    learning.close();
    agentEvents.close();
    for (const listener of closeListeners) listener();
    closeListeners.clear();
  }
  try {
    const handle = startAgentBridge({
      ...connection,
      ...(preserveIdentity && { registrationRuntimeId: connection.runtimeId }),
      runtimeConfig: config,
      requestHandler: {
        ...requests.requests,
        sparkChat: createSparkChatAccess({ config, sessions: services.sessions, passiveLearning: learning.service }),
        approvalControls: { ...requests.approvals, subscribeEvents: requests.subscribe.bind(requests) },
      },
      agents,
      agentNotifications: { read: (cursor, since) => agents.projection.notifications!(cursor, since) },
      subscribeAgentEvents: agentEvents.subscribe,
      sessionStore: services.sessions,
      attachmentStore: services.attachments,
    });
    return { getStatus: handle.getStatus, fence() {
      if (fenced || inFlight > 0 || hasActivePeer(peer)) throw new Error("socket_connection_busy");
      fenced = true;
      return () => { fenced = false; };
    }, async stop() {
      detached = true;
      unsubscribe();
      try { await handle.stop(); } finally { closePeer(); }
    } };
  } catch {
    unsubscribe();
    closePeer();
    throw new Error("runtime_bridge_start_failed");
  }
}

/** Exactly one transport for this owner's lifetime. Network reconnect is owned by the bridge. */
export function createLocalOwnerBridge(config: RuntimeConfig, hasActivePeer: (peer: LocalRuntimePeer) => boolean = () => false) {
  let current: RuntimeBridgeConnection | undefined;
  let handle: ReturnType<typeof openBridgePeer> | undefined;
  let stopped = false;
  let stopping: Promise<void> | undefined;
  return {
    start(value: RuntimeBridgeConnection, owner: LocalRuntimeOwner, preserveIdentity = false): void {
      if (stopped) throw new Error("local_runtime_owner_stopped");
      const connection = validateRuntimeBridgeConnection(value, preserveIdentity ? value.runtimeId : config.runtimeId);
      if (current) {
        if (current.url !== connection.url || current.token !== connection.token)
          throw new Error("runtime_bridge_connection_conflict");
        return;
      }
      handle = openBridgePeer(config, owner, connection, preserveIdentity, hasActivePeer);
      current = connection;
    },
    getStatus: () => handle?.getStatus(),
    fence: () => handle?.fence(),
    pause(): Promise<void> {
      current = undefined;
      const closing = handle;
      handle = undefined;
      return closing?.stop() ?? Promise.resolve();
    },
    stop(): Promise<void> {
      stopped = true;
      current = undefined;
      stopping ??= handle?.stop() ?? Promise.resolve();
      handle = undefined;
      return stopping;
    },
  };
}
