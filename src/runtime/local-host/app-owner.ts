import type WebSocket from "ws";
import {
  createRuntimeApplication,
  type RuntimeApplication,
  type RuntimeDependencyOverrides,
} from "../composition.js";
import type { RuntimeConfig } from "../ports.js";
import type { RunRequestMessage } from "../request/contracts.js";
import type { LocalRuntimeOwner, LocalRuntimePeer } from "./contracts.js";
import { LocalMemoryDispatcher } from "./app-memory-dispatch.js";
import {
  LocalRequestControls,
  type LocalRequestRunOptions,
} from "./app-request-control.js";
import { dispatchLocalServiceCall } from "./app-service-dispatch.js";
import { LocalRuntimeOwnerActivity } from "./owner-activity.js";
import { dispatchLocalLearningCall } from "./app-learning-dispatch.js";
import { projectLearningChangedEvent } from "./learning-events.js";
import { SavedRequestApprovals } from "./saved-approvals.js";

export async function createLocalRuntimeOwner(
  config: RuntimeConfig,
  overrides: RuntimeDependencyOverrides = {},
): Promise<LocalRuntimeOwner> {
  const listeners = new Set<(event: unknown) => void>();
  const publish = (event: unknown) => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        /* A subscribing view cannot change canonical request execution. */
      }
    }
  };
  const controls = new LocalRequestControls(publish);
  const activity = new LocalRuntimeOwnerActivity();
  const application = createRuntimeApplication(config, {
    ...overrides,
    scheduledRequestOptions: (run) => controls.scheduled(run),
  });
  const memory = new LocalMemoryDispatcher(application.services.longTermMemory);
  const savedApprovals = new SavedRequestApprovals(
    application,
    controls,
    activity,
    publish,
  );
  const unsubscribe = application.subscribeScheduledEvents((event) => {
    publish({ type: "scheduled.event", event });
    if (event.type === "completed" || event.type === "failed")
      controls.finish(String(event.requestId));
  });
  const unsubscribeLearning = application.services.passiveLearning?.subscribe(
    (change) => {
      const event = projectLearningChangedEvent(change);
      publish({ type: "learning.changed", ...(event ? { event } : {}) });
    },
  );
  try {
    await savedApprovals.recover();
    await application.start();
  } catch (error) {
    activity.stop();
    application.services.requestAdmission?.close();
    unsubscribe();
    unsubscribeLearning?.();
    await application.stop();
    throw error;
  }
  let shutdown: Promise<void> | undefined;
  return {
    call(method, args, peer) {
      return activity.run(async () => {
        if (method === "controls.register") return controls.register(peer);
        if (method === "request.active")
          return controls.hasActiveRequest(args[0], args[1]);
        if (method === "request.approvals")
          return [
            ...(await savedApprovals.list(args[0])),
            ...controls.listApprovals(args[0]),
          ];
        if (method === "request.approval.decide")
          return (
            (await savedApprovals.decide(args[0], peer)) ??
            controls.decideApproval(args[0], peer)
          );
        if (method === "request.attach") {
          if (await savedApprovals.attach(args[0], args[1], peer)) return;
          return controls.attach(args[0], args[1], peer);
        }
        if (method === "request.steer") return controls.steer(args[0], args[1]);
        if (method === "request.cancel") {
          if (await savedApprovals.cancel(args[0], args[1], args[2]))
            return { accepted: true };
          return controls.cancel(args[0], args[1], args[2]);
        }
        if (method === "request.run")
          return savedApprovals.track(
            String((args[0] as RunRequestMessage)?.requestId),
            () =>
              runPeerRequest(
                application,
                controls,
                activity,
                savedApprovals,
                args,
                peer,
              ),
          );
        if (method.startsWith("memory.")) {
          const result = await memory.call(method, args, peer);
          if (
            [
              "memory.create",
              "memory.update",
              "memory.delete",
              "memory.clear",
            ].includes(method)
          )
            publish({ type: "learning.changed" });
          return result;
        }
        if (method.startsWith("learning."))
          return dispatchLocalLearningCall(
            application.services.passiveLearning,
            method,
            args,
          );
        return dispatchLocalServiceCall(application.services, method, args);
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop() {
      if (shutdown) return shutdown;
      activity.stop();
      application.services.requestAdmission?.close();
      memory.stop();
      controls.stop();
      unsubscribe();
      unsubscribeLearning?.();
      listeners.clear();
      shutdown = application.stop();
      return shutdown;
    },
    isIdle() {
      if (!activity.isIdle()) return false;
      return application.services.requestAdmission?.isIdle() ?? true;
    },
    async whenIdle() {
      await Promise.all([
        activity.whenIdle(),
        application.services.requestAdmission?.whenIdle(),
      ]);
    },
  };
}

async function runPeerRequest(
  application: RuntimeApplication,
  controls: LocalRequestControls,
  activity: LocalRuntimeOwnerActivity,
  savedApprovals: SavedRequestApprovals,
  args: readonly unknown[],
  peer: LocalRuntimePeer,
): Promise<import("../request/handler.js").RequestHandlerOutcome> {
  const message = args[0] as RunRequestMessage | undefined;
  if (!message || typeof message.requestId !== "string")
    throw new Error("local_runtime_request_invalid");
  const options = controls.ordinary(
    message.requestId,
    peer,
    (args[1] ?? {}) as LocalRequestRunOptions,
    typeof message.sessionId === "string" ? message.sessionId : "",
  );
  const durable =
    (args[1] as LocalRequestRunOptions | undefined)?.durableApprovals === true;
  if (durable)
    options.approvalExecution = { activation: savedApprovals.activation() };
  const socket = {
    send(data: string) {
      controls.send(message.requestId, JSON.parse(data));
    },
  } as WebSocket;
  try {
    await peer.callClient("request.accepted", [message.requestId]);
    activity.assertAcceptingRequests();
    const result = await application.requests.handle(socket, message, options);
    await controls.drain(message.requestId);
    return result;
  } finally {
    controls.finish(message.requestId);
  }
}
