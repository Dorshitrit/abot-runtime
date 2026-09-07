import type { SessionStore } from "../ports.js";
import type { RuntimeAttachmentStore } from "../attachments/store.js";
import type { SchedulerService } from "../scheduler/contracts.js";
import type { LocalRuntimeCallHandler } from "./contracts.js";
import { bindManagedSessionAttachmentDeletion } from "../session/session-attachment-deletion.js";
import {
  LOCAL_SESSION_METHODS,
  LOCAL_ATTACHMENT_METHODS,
  LOCAL_SCHEDULER_METHODS,
} from "./app-service-dispatch.js";

/** Projections of owner APIs; lifecycle remains with the managed application. */
export function createLocalServiceClients(call: LocalRuntimeCallHandler) {
  const service = <T>(prefix: string, methods: readonly string[]): T =>
    Object.fromEntries(
      methods.map((method) => [
        method,
        (...args: unknown[]) => call(`${prefix}.${method}`, args),
      ]),
    ) as T;
  const sessions = service<SessionStore>("sessions", LOCAL_SESSION_METHODS);
  const attachments = service<RuntimeAttachmentStore>(
    "attachments",
    LOCAL_ATTACHMENT_METHODS,
  );
  const scheduler = service<Omit<SchedulerService, "start" | "stop">>(
    "scheduler",
    LOCAL_SCHEDULER_METHODS,
  );
  bindManagedSessionAttachmentDeletion(sessions, attachments);
  return { sessions, attachments, scheduler };
}
