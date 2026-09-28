import type { LocalPendingToolApproval } from "../../runtime/local-host/request-approval-contracts.js";
import type { JsonObject, RuntimeEnvironment } from "./contracts.js";
import type { LocalRequestExecution } from "./request-execution.js";
import type {
  PendingWebToolApproval,
  WebToolApprovalDecision,
} from "./pending-tool-approvals.js";
import { getString } from "./http.js";

function matchesApprovalScope(
  pending: LocalPendingToolApproval,
  decision: WebToolApprovalDecision,
): boolean {
  if (pending.sessionId !== decision.sessionId) return false;
  if (pending.request.requestId !== decision.requestId) return false;
  return pending.request.approvalId === decision.approvalId;
}

function isApprovalRequiredEvent(
  event: JsonObject,
  approvalId: string,
): boolean {
  if (event.name !== "tool.approval.required") return false;
  return event.approvalId === approvalId;
}

/** Read and decide canonical saved waits and the owner's legacy live approvals. */
export class ManagedWebToolApprovals {
  constructor(
    private readonly environment: (id: string) => RuntimeEnvironment,
    private readonly requests: LocalRequestExecution,
  ) {}

  async list(environmentId: string): Promise<PendingWebToolApproval[]> {
    const environment = this.environment(environmentId);
    const pending = await environment.approvals.list();
    const approvals: PendingWebToolApproval[] = [];
    for (const entry of pending) {
      const events = await this.events(environmentId, environment, entry);
      const event = events.find((value) =>
        isApprovalRequiredEvent(value, entry.request.approvalId),
      );
      if (!event) continue;
      approvals.push({
        ...(entry.wait ? entry.wait : {}),
        environmentId,
        sessionId: entry.sessionId,
        requestId: entry.request.requestId,
        approvalId: entry.request.approvalId,
        event,
      });
    }
    return approvals;
  }

  async decide(decision: WebToolApprovalDecision): Promise<boolean> {
    const environment = this.environment(decision.environmentId);
    const pending = await environment.approvals.list(decision.sessionId);
    const entry = pending.find((value) =>
      matchesApprovalScope(value, decision),
    );
    if (!entry && !decision.waitId) return false;
    if (entry && !entry.wait)
      await this.attach(decision.environmentId, environment, entry);
    const result = await environment.approvals.decide({
      sessionId: decision.sessionId,
      requestId: decision.requestId,
      approvalId: decision.approvalId,
      approved: decision.approved,
      reason: decision.reason,
      ...(decision.waitId
        ? {
            generation: decision.generation,
            waitId: decision.waitId,
            revision: decision.revision,
            commandId: decision.commandId,
          }
        : {}),
    });
    return result.accepted;
  }

  async resume(environmentId: string, requestId: string): Promise<void> {
    const environment = this.environment(environmentId);
    const pending = await environment.approvals.list();
    const entry = pending.find(
      (value) => value.request.requestId === requestId,
    );
    if (entry && !entry.wait)
      await this.attach(environmentId, environment, entry);
  }

  async resolveRealtime(
    message: JsonObject,
    defaultEnvironmentId: string,
  ): Promise<boolean> {
    if (typeof message.approved !== "boolean") return false;
    const approvalId = getString(message.approvalId);
    if (!approvalId) return false;
    const environmentId =
      getString(message.environment) || defaultEnvironmentId;
    if (typeof message.waitId === "string") {
      return this.decide({
        environmentId,
        approvalId,
        sessionId: getString(message.sessionId),
        requestId: getString(message.requestId),
        generation: getString(message.generation),
        waitId: message.waitId,
        revision: Number(message.revision),
        commandId: getString(message.commandId),
        approved: message.approved,
        ...(typeof message.reason === "string"
          ? { reason: message.reason }
          : {}),
      });
    }
    const approvals = await this.list(environmentId);
    const pending = approvals.find((value) => value.approvalId === approvalId);
    if (!pending) return false;
    return this.decide({
      ...pending,
      approved: message.approved,
      reason: getString(message.reason).trim() || undefined,
    });
  }

  private async attach(
    environmentId: string,
    environment: RuntimeEnvironment,
    pending: LocalPendingToolApproval,
  ): Promise<void> {
    const events = await this.events(environmentId, environment, pending);
    await this.requests.attachToolApproval(
      environmentId,
      environment,
      pending,
      events,
    );
  }

  private async events(
    environmentId: string,
    environment: RuntimeEnvironment,
    pending: LocalPendingToolApproval,
  ): Promise<readonly JsonObject[]> {
    const active = this.requests.activeReplayForSession(
      pending.request.requestId,
      pending.sessionId,
      environmentId,
    );
    const hasRequiredEvent = active?.some((event) =>
      isApprovalRequiredEvent(event, pending.request.approvalId),
    );
    if (hasRequiredEvent) return active!;
    const replay = await environment.services.sessions.getRequestReplayById(
      pending.request.requestId,
    );
    if (replay?.sessionId !== pending.sessionId) return [];
    return replay.events;
  }
}
