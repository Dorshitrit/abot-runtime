import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import type { RuntimeApplication } from "../composition.js";
import type { LocalRuntimePeer } from "./contracts.js";
import type { LocalRequestControls } from "./app-request-control.js";
import type { LocalRuntimeOwnerActivity } from "./owner-activity.js";
import type {
  SessionRequestLifecycleSnapshot,
  SessionWaitExpectation,
} from "../../sessions/request-lifecycle/contracts.js";
import {
  REQUEST_APPROVAL_SNAPSHOT,
  type RequestApprovalSnapshot,
} from "../request/approval-wait/snapshot.js";
import { validateApprovalResume } from "../request/approval-wait/preflight.js";
import { hasApprovalDecisionIdentity } from "./app-request-approvals.js";
import type {
  LocalPendingToolApproval,
  LocalToolApprovalDecisionInput,
  LocalToolApprovalDecisionResult,
} from "./request-approval-contracts.js";
import type { ToolApprovalRequest } from "../ports.js";
import { traceDebug } from "../observability/debug-logger.js";

type DurableDecision = LocalToolApprovalDecisionInput & {
  generation: string;
  waitId: string;
  revision: number;
  commandId: string;
};
function hasDurableIdentity(
  input: LocalToolApprovalDecisionInput,
): input is DurableDecision {
  return (
    typeof input.generation === "string" &&
    input.generation.length > 0 &&
    typeof input.waitId === "string" &&
    input.waitId.length > 0 &&
    Number.isSafeInteger(input.revision) &&
    typeof input.commandId === "string" &&
    input.commandId.length > 0
  );
}
function expectation(
  current: SessionRequestLifecycleSnapshot,
): SessionWaitExpectation {
  if (!current.wait) throw new Error("request_not_waiting");
  return {
    requestId: current.requestId,
    generation: current.generation,
    revision: current.revision,
    waitId: current.wait.waitId,
  };
}

/** Session storage owns every wait. This owner retains only actively running promises. */
export class SavedRequestApprovals {
  readonly ownerEpoch = randomUUID();
  private readonly retiring = new Map<string, Promise<unknown>>();
  private readonly store;

  constructor(
    private readonly application: RuntimeApplication,
    private readonly controls: LocalRequestControls,
    private readonly activity: LocalRuntimeOwnerActivity,
    private readonly publish: (event: unknown) => void,
  ) {
    this.store = application.services.sessions.requestLifecycle;
  }

  activation() {
    return { ownerEpoch: this.ownerEpoch, activationId: randomUUID() };
  }

  async track<T>(requestId: string, operation: () => Promise<T>): Promise<T> {
    if (this.retiring.has(requestId))
      throw new Error("local_runtime_request_already_active");
    const pending = operation();
    this.retiring.set(requestId, pending);
    try {
      return await pending;
    } finally {
      if (this.retiring.get(requestId) === pending)
        this.retiring.delete(requestId);
    }
  }

  async recover(): Promise<void> {
    if (!this.store) return;
    const sessions = await this.application.services.sessions.getAllSessions();
    for (const session of sessions) {
      for (const request of session.requests ?? []) {
        if (request.status !== "streaming" || !request.lifecycle) continue;
        const current = await this.store.get(session.id, request.requestId);
        if (!current?.activation || current.status !== "streaming") continue;
        await this.store.interruptActivation(session.id, {
          expected: {
            requestId: current.requestId,
            generation: current.generation,
            revision: current.revision,
            ...current.activation,
          },
          commandId: randomUUID(),
          message: {
            content: "The running task was interrupted by a runtime restart.",
          },
        });
      }
    }
  }

  async list(sessionId?: unknown): Promise<LocalPendingToolApproval[]> {
    if (!this.store) return [];
    if (sessionId !== undefined && typeof sessionId !== "string") return [];
    const waiting = await this.store.listWaiting(sessionId);
    return waiting.flatMap((current) => {
      const wait = current.wait!;
      return wait.approvals
        .filter(
          (approval) =>
            !current.decisionReceipts.some(
              (receipt) =>
                receipt.waitId === wait.waitId &&
                receipt.approvalId === approval.approvalId,
            ),
        )
        .map((approval) => ({
          sessionId: current.sessionId,
          request: structuredClone(
            approval.presentation,
          ) as ToolApprovalRequest,
          wait: {
            generation: current.generation,
            waitId: wait.waitId,
            revision: current.revision,
          },
        }));
    });
  }

  async attach(
    requestId: unknown,
    sessionId: unknown,
    peer: LocalRuntimePeer,
  ): Promise<boolean> {
    if (
      !this.store ||
      typeof requestId !== "string" ||
      typeof sessionId !== "string"
    )
      return false;
    const current = await this.store.get(sessionId, requestId);
    if (current?.status !== "awaiting_approval") return false;
    // Readiness means this saved response can be read; it starts no execution.
    await peer.callClient("request.accepted", [requestId]);
    return true;
  }

  async cancel(
    requestId: unknown,
    sessionId: unknown,
    input: unknown,
  ): Promise<boolean> {
    if (
      !this.store ||
      typeof requestId !== "string" ||
      typeof sessionId !== "string"
    )
      return false;
    const current = await this.store.get(sessionId, requestId);
    const command = input as
      | Partial<import("../request/cancellation.js").SavedWaitCancellation>
      | undefined;
    if (
      !current ||
      !command ||
      command.generation !== current.generation ||
      typeof command.waitId !== "string" ||
      !Number.isSafeInteger(command.revision) ||
      typeof command.commandId !== "string" ||
      !command.commandId
    )
      return false;
    const result = await this.store.cancelWait(sessionId, {
      expected: {
        requestId,
        generation: command.generation,
        revision: command.revision!,
        waitId: command.waitId,
      },
      commandId: command.commandId,
      message: { content: "I stopped the task at your request." },
    });
    if (result.accepted) this.emit(result.events, sessionId);
    return result.accepted;
  }

  async decide(
    input: unknown,
    peer: LocalRuntimePeer,
  ): Promise<LocalToolApprovalDecisionResult | undefined> {
    if (!this.store || !hasApprovalDecisionIdentity(input)) return undefined;
    const current = await this.store.get(input.sessionId, input.requestId);
    const isDurable =
      current?.status === "awaiting_approval" || input.waitId !== undefined;
    if (!isDurable) return undefined;
    if (!hasDurableIdentity(input))
      return { accepted: false, reason: "invalid_approval_decision" };
    const previous = await this.store.getDecisionReceipt(
      input.sessionId,
      input.requestId,
      input.generation,
      input.commandId,
    );
    if (previous) {
      const matches =
        previous.waitId === input.waitId &&
        previous.approvalId === input.approvalId &&
        previous.approved === input.approved &&
        previous.reason === input.reason;
      return matches
        ? { accepted: true, duplicate: true }
        : { accepted: false, reason: "approval_conflict" };
    }
    if (!current?.wait || current.status !== "awaiting_approval")
      return { accepted: false, reason: "approval_not_pending" };
    const expected = expectation(current);
    if (
      expected.generation !== input.generation ||
      expected.waitId !== input.waitId ||
      expected.revision !== input.revision
    )
      return { accepted: false, reason: "approval_conflict" };
    const remaining = current.wait.approvals.filter(
      (approval) =>
        !current.decisionReceipts.some(
          (receipt) =>
            receipt.waitId === input.waitId &&
            receipt.approvalId === approval.approvalId,
        ),
    );
    if (!remaining.some((approval) => approval.approvalId === input.approvalId))
      return { accepted: false, reason: "approval_not_pending" };
    const finalDecision = remaining.length === 1;
    let snapshot: RequestApprovalSnapshot | undefined;
    if (finalDecision) {
      await this.retiring.get(input.requestId)?.catch(() => undefined);
      try {
        const reference = await this.store.getContinuation(
          input.sessionId,
          expected,
        );
        if (!reference) return { accepted: false, reason: "approval_conflict" };
        if (
          reference.schema !== REQUEST_APPROVAL_SNAPSHOT ||
          reference.version !== 1
        )
          return { accepted: false, reason: "approval_resume_unavailable" };
        snapshot = (await this.store.readContinuation(
          input.sessionId,
          reference,
        )) as RequestApprovalSnapshot;
        await validateApprovalResume(
          this.application.services,
          snapshot,
          current,
        );
      } catch (error) {
        traceDebug("runtime.approvals", "resume.preflight_failed", {
          requestId: input.requestId,
          error: error instanceof Error ? error.message : "unknown",
        });
        return { accepted: false, reason: "approval_resume_unavailable" };
      }
    }
    const commit = () =>
      this.commitDecisionAndResume(input, expected, snapshot, peer);
    const admission = this.application.services.requestAdmission;
    // Acquire admission while the saved wait still blocks the scheduler. The
    // resumed handler enters the same admission synchronously before release.
    return admission ? admission.run(input.sessionId, commit, true) : commit();
  }

  private async commitDecisionAndResume(
    input: DurableDecision,
    expected: SessionWaitExpectation,
    snapshot: RequestApprovalSnapshot | undefined,
    peer: LocalRuntimePeer,
  ): Promise<LocalToolApprovalDecisionResult> {
    this.activity.assertAcceptingRequests();
    const activation = snapshot ? this.activation() : undefined;
    let result;
    try {
      result = await this.store!.commitDecision(input.sessionId, {
        expected,
        commandId: input.commandId,
        approvalId: input.approvalId,
        approved: input.approved,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(activation ? { resumeActivation: activation } : {}),
      });
    } catch (error) {
      // An uncertain storage acknowledgement never authorizes dispatch.
      await this.interruptUncertainClaim(input);
      throw error;
    }
    if (!result.accepted)
      return { accepted: false, reason: "approval_conflict" };
    this.emit(result.events, input.sessionId);
    if (snapshot && activation && !result.duplicate) {
      const resumed = result.current;
      const acceptedSnapshot = snapshot;
      void this.activity
        .run(() =>
          this.track(input.requestId, () =>
            this.resume(acceptedSnapshot, resumed, expected, peer),
          ),
        )
        .catch(async (error) => {
          try {
            await this.interruptUncertainClaim(input);
          } catch (interruptionError) {
            traceDebug("runtime.approvals", "resume.interruption_unconfirmed", {
              requestId: input.requestId,
              error:
                interruptionError instanceof Error
                  ? interruptionError.message
                  : "unknown",
            });
          }
          traceDebug("runtime.approvals", "resume.failed", {
            requestId: input.requestId,
            error: error instanceof Error ? error.message : "unknown",
          });
        });
    }
    return { accepted: true, ...(result.duplicate ? { duplicate: true } : {}) };
  }

  private async resume(
    snapshot: RequestApprovalSnapshot,
    current: SessionRequestLifecycleSnapshot,
    consumedWait: SessionWaitExpectation,
    peer: LocalRuntimePeer,
  ): Promise<void> {
    const { requestId, sessionId } = current;
    const options = this.controls.ordinary(
      requestId,
      peer,
      { approvalAvailable: true },
      sessionId,
      consumedWait,
    );
    const decisions = snapshot.runner.preparedGroup.entries.flatMap((entry) => {
      // The consumed wait has been removed; exact approval IDs bind its saved actions.
      const saved = current.decisionReceipts.find(
        (item) =>
          item.waitId === consumedWait.waitId &&
          item.approvalId === entry.approvalRequest?.approvalId,
      );
      return saved
        ? [
            {
              approvalId: saved.approvalId,
              actionFingerprint: entry.actionFingerprint,
              recorded: true,
              decision: {
                approved: saved.approved,
                ...(saved.reason !== undefined ? { reason: saved.reason } : {}),
              },
            },
          ]
        : [];
    });
    const ws = {
      send: (data: string) => this.emit([JSON.parse(data)], sessionId),
    } as WebSocket;
    try {
      await this.application.requests.handle(
        ws,
        {
          type: "run_request",
          requestId,
          sessionId,
          text: snapshot.originalPrompt,
          agentMode: snapshot.seed.agentMode,
          modelPreference: snapshot.seed.modelPreference,
          toolPermissionMode: snapshot.seed.toolPermissionMode,
        },
        {
          ...options,
          approvalExecution: {
            activation: current.activation!,
            resume: { snapshot, current, decisions },
          },
        },
      );
    } finally {
      this.controls.finish(requestId);
    }
  }

  private emit(
    events: readonly Record<string, unknown>[],
    sessionId: string,
  ): void {
    for (const event of events)
      this.publish({
        type: "request.event",
        event: {
          ...event,
          sessionId,
          environment: this.application.services.config.runtimeId,
          requestOrigin: "approval",
        },
      });
  }

  private async interruptUncertainClaim(input: DurableDecision): Promise<void> {
    const current = await this.store!.get(input.sessionId, input.requestId);
    if (current?.status !== "streaming" || !current.activation) return;
    if (current.generation !== input.generation) return;
    const receipt = current.decisionReceipts.find(
      (value) => value.commandId === input.commandId,
    );
    if (receipt?.activation?.activationId !== current.activation.activationId)
      return;
    if (receipt.activation.ownerEpoch !== this.ownerEpoch) return;
    const result = await this.store!.interruptActivation(input.sessionId, {
      expected: {
        requestId: current.requestId,
        generation: current.generation,
        revision: current.revision,
        ...current.activation,
      },
      commandId: randomUUID(),
      message: {
        content:
          "The running task was interrupted before its outcome was confirmed.",
      },
    });
    if (result.accepted) this.emit(result.events, input.sessionId);
  }
}
