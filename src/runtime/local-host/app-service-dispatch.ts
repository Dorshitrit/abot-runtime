import type { RuntimeEnvironmentServices } from "../composition.js";
import type { RuntimeAttachmentStore } from "../attachments/store.js";
import type { SessionStore } from "../ports.js";
import type { SchedulerService } from "../scheduler/contracts.js";

export const LOCAL_SESSION_METHODS = [
  "getOrCreateSession",
  "getAllSessions",
  "listSessions",
  "getSessionById",
  "getSessionSnapshot",
  "getRequestReplayById",
  "updateSessionTitle",
  "updateSessionRuntimeMode",
  "appendMessage",
  "appendContextEntry",
  "upsertArtifactPaths",
  "startRequestStream",
  "appendRequestEvent",
  "deleteSession",
  "deleteSessionWithStats",
  "resetSession",
  "clearSessionMessages",
  "deleteMessage",
  "deleteMessageWithStats",
  "compareAndSwapSessionMemoryCheckpoint",
] as const satisfies readonly (keyof SessionStore)[];

export const LOCAL_ATTACHMENT_METHODS = [
  "saveAttachment",
  "validateAttachmentReferences",
  "resolveAttachment",
  "deleteAttachment",
  "deleteSessionAttachments",
] as const satisfies readonly (keyof RuntimeAttachmentStore)[];

export const LOCAL_SCHEDULER_METHODS = [
  "tick",
  "create",
  "list",
  "get",
  "update",
  "pause",
  "resume",
  "cancel",
  "runNow",
  "deleteSession",
  "listRuns",
] as const satisfies readonly (keyof SchedulerService)[];

type ServiceTarget = Record<string, unknown>;

function selectServiceMethod(
  target: unknown,
  method: string,
  methods: readonly string[],
): (...args: unknown[]) => unknown {
  if (!methods.includes(method))
    throw new Error("local_runtime_method_unknown");
  if (!target) throw new Error("local_runtime_service_unavailable");
  const selected = (target as ServiceTarget)[method];
  if (typeof selected !== "function")
    throw new Error("local_runtime_method_unavailable");
  return selected.bind(target) as (...args: unknown[]) => unknown;
}

export async function dispatchLocalServiceCall(
  services: RuntimeEnvironmentServices,
  method: string,
  args: readonly unknown[],
): Promise<unknown> {
  const [service, operation, extra] = method.split(".");
  if (!operation || extra) throw new Error("local_runtime_method_unknown");
  if (service === "sessions")
    return selectServiceMethod(
      services.sessions,
      operation,
      LOCAL_SESSION_METHODS,
    )(...args);
  if (service === "attachments")
    return selectServiceMethod(
      services.attachments,
      operation,
      LOCAL_ATTACHMENT_METHODS,
    )(...args);
  if (service === "scheduler")
    return selectServiceMethod(
      services.scheduler,
      operation,
      LOCAL_SCHEDULER_METHODS,
    )(...args);
  throw new Error("local_runtime_method_unknown");
}
