import { hasAutomationSessionOrigin, isAutomationSessionLockedError } from "../../sessions/automation-session-origin.js";
import type { RuntimeEnvironmentServices } from "../composition.js";
import type { LocalRuntimeOwnerActivity } from "./owner-activity.js";
import type { RuntimeMaintenanceService, RuntimeSessionsResetResult } from "./maintenance-contracts.js";
import { isSparkSession, SPARK_SESSION_ID } from "../../sessions/spark-session.js";
import { processDebugLogger } from "../observability/debug-logger.js";
import { assertRuntimeMaintenanceScope } from "./maintenance-scope.js";

export function isLocalMaintenanceMethod(method: string): boolean {
  return method === "maintenance.resetSessions" || method === "maintenance.clearLogs";
}

/** Destructive management runs at the environment owner, never in a browser-side store. */
export function createLocalRuntimeMaintenance(options: {
  services: Pick<RuntimeEnvironmentServices, "config" | "sessions" | "attachments" | "automations" | "requestAdmission">;
  activity: LocalRuntimeOwnerActivity;
  verifyScope?: typeof assertRuntimeMaintenanceScope;
}): RuntimeMaintenanceService & { call(method: string, args: readonly unknown[]): Promise<unknown> } {
  const { services, activity } = options;
  const verifyScope = options.verifyScope ?? assertRuntimeMaintenanceScope;
  // Keep unsuccessful canonical cleanup targets available for a later explicit reset.
  const unfinishedDeletions = new Set<string>();

  function runMaintenance<T>(operation: () => Promise<T>): Promise<T> {
    return activity.runExclusive(async () => {
      if (!services.requestAdmission) throw new Error("runtime_maintenance_unavailable");
      const release = services.requestAdmission.reserveMaintenance();
      try { return await operation(); }
      finally { release(); }
    });
  }

  async function resetSessions(): Promise<RuntimeSessionsResetResult> {
    return runMaintenance(async () => {
      await verifyScope(services.config, "sessions");
      const sessions = await services.sessions.getAllSessions();
      const waiting = await services.sessions.requestLifecycle?.listWaiting();
      if (waiting?.length) throw new Error("runtime_maintenance_pending_approvals");
      const deletedSessionIds: string[] = [];
      const clearedSessionIds: string[] = [];
      const failedSessionIds: string[] = [];
      let deletedMessages = 0;
      let deletedRequests = 0;
      const targets = new Map(sessions.filter(session => !hasAutomationSessionOrigin(session)).map(session => [session.id, isSparkSession(session)]));
      if (!services.attachments.listSessionAttachmentOwners || !services.sessions.assertInteractiveSession || !services.automations?.listAttachmentOwners)
        throw new Error("runtime_maintenance_unavailable");
      // Preparation precedes scheduler admission: capture candidate directories before its markers and journal.
      const attachmentOwners = await services.attachments.listSessionAttachmentOwners();
      const automationOwners = new Set(await services.automations.listAttachmentOwners());
      const internalOwners = new Set(sessions.filter(hasAutomationSessionOrigin).map(session => session.id));
      for (const id of attachmentOwners) {
        if (targets.has(id) || internalOwners.has(id) || automationOwners.has(id)) continue;
        // Interactive listing hides automation records; absence alone is not ownership evidence.
        try { await services.sessions.assertInteractiveSession(id); }
        catch (error) {
          if (isAutomationSessionLockedError(error)) continue;
          throw error;
        }
        targets.set(id, id === SPARK_SESSION_ID);
      }
      for (const id of unfinishedDeletions) if (!targets.has(id)) targets.set(id, false);
      for (const [sessionId, spark] of targets) {
        try {
          if (spark) {
            const result = await services.sessions.clearSessionMessages(sessionId);
            await services.attachments.deleteSessionAttachments(sessionId);
            clearedSessionIds.push(sessionId);
            deletedMessages += result?.deletedMessages ?? 0;
            deletedRequests += result?.deletedRequests ?? 0;
            continue;
          }
          unfinishedDeletions.add(sessionId);
          const result = await services.sessions.deleteSessionWithStats(sessionId);
          // Canonical finalizers skip missing transcripts; an upload-only owner still has bytes.
          if (!result.deleted) await services.attachments.deleteSessionAttachments(sessionId);
          unfinishedDeletions.delete(sessionId);
          deletedSessionIds.push(sessionId);
          deletedMessages += result.deletedMessages;
          deletedRequests += result.deletedRequests;
        } catch {
          failedSessionIds.push(sessionId);
        }
      }
      return { complete: failedSessionIds.length === 0, deletedSessionIds, clearedSessionIds,
        failedSessionIds, deletedMessages, deletedRequests };
    });
  }

  async function clearLogs() {
    return runMaintenance(async () => {
      await verifyScope(services.config, "logs");
      return processDebugLogger.clear(services.config.paths.traceFile, services.config.paths.sharedDir);
    });
  }

  return { resetSessions, clearLogs, call(method, args) {
    if (args.length) return Promise.reject(new Error("runtime_maintenance_input_invalid"));
    if (method === "maintenance.resetSessions") return resetSessions();
    if (method === "maintenance.clearLogs") return clearLogs();
    return Promise.reject(new Error("local_runtime_method_unknown"));
  } };
}
