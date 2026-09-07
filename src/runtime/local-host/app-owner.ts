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
  const unsubscribe = application.subscribeScheduledEvents((event) => {
    publish({ type: "scheduled.event", event });
    if (event.type === "completed" || event.type === "failed")
      controls.finish(String(event.requestId));
  });
  try {
    await application.start();
  } catch (error) {
    activity.stop();
    application.services.requestAdmission?.close();
    unsubscribe();
    await application.stop();
    throw error;
  }
  let shutdown: Promise<void> | undefined;
  return {
    call(method, args, peer) {
      return activity.run(async () => {
        if (method === "controls.register") return controls.register(peer);
        if (method === "request.steer") return controls.steer(args[0], args[1]);
        if (method === "request.run")
          return runPeerRequest(application, controls, activity, args, peer);
        if (method.startsWith("memory."))
          return memory.call(method, args, peer);
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
  args: readonly unknown[],
  peer: LocalRuntimePeer,
): Promise<void> {
  const message = args[0] as RunRequestMessage | undefined;
  if (!message || typeof message.requestId !== "string")
    throw new Error("local_runtime_request_invalid");
  const options = controls.ordinary(
    message.requestId,
    peer,
    (args[1] ?? {}) as LocalRequestRunOptions,
  );
  let connected = true;
  const removeClose = peer.onClose(() => {
    connected = false;
  });
  let delivery = Promise.resolve();
  const socket = {
    send(data: string) {
      if (!connected) return;
      const event: unknown = JSON.parse(data);
      delivery = delivery
        .then(async () => {
          if (connected)
            await peer.callClient("request.event", [message.requestId, event]);
        })
        .catch(() => {
          connected = false;
        });
    },
  } as WebSocket;
  try {
    await peer.callClient("request.accepted", [message.requestId]);
    activity.assertAcceptingRequests();
    await application.requests.handle(socket, message, options);
    await delivery;
  } finally {
    removeClose();
    controls.finish(message.requestId);
  }
}
