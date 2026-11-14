import type WebSocket from "ws";
import type { RuntimeRequestHandler } from "../runtime/composition.js";
import type { RuntimeRequestApprovalControls } from "../runtime/request/approval-controls.js";
import type { SessionStore, ToolApprovalController } from "../runtime/ports.js";
import type { SessionRequestReplay } from "../sessions/types.js";
import { BridgeApprovalDelivery } from "./request-approval-delivery.js";
import {
  approvalResponseIdentity,
  DURABLE_APPROVAL_MODE,
  readApprovalDecision,
  readApprovalScope,
  type BridgeApprovalScope,
} from "./request-approval-protocol.js";

type ApprovalAccessOptions = Readonly<{
  controls: RuntimeRequestApprovalControls;
  sessions: SessionStore;
  currentSocket: () => WebSocket | undefined;
  legacyController: () => ToolApprovalController;
  steer?: RuntimeRequestHandler["steer"];
}>;

/** Adapts the existing owner API. No continuation, permission or TTL state lives here. */
export function createBridgeApprovalAccess(options: ApprovalAccessOptions) {
  const delivery = new BridgeApprovalDelivery(options.currentSocket);
  const unsubscribe = options.controls.subscribeEvents((event) => {
    if (event.requestOrigin !== "approval") return;
    delivery.publish(event);
  });

  async function replay(
    scope: BridgeApprovalScope,
  ): Promise<SessionRequestReplay> {
    const current = await options.sessions.getRequestReplayById(
      scope.requestId,
      Number.MAX_SAFE_INTEGER,
      scope.sessionId,
    );
    if (!current) throw new Error("approval_request_not_found");
    if (
      current.sessionId !== scope.sessionId ||
      current.requestId !== scope.requestId
    )
      throw new Error("approval_scope_mismatch");
    return current;
  }

  function assertCurrent(socket: WebSocket): void {
    if (!delivery.isCurrent(socket))
      throw new Error("approval_connection_changed");
  }

  async function pendingForScope(
    socket: WebSocket,
    scope: BridgeApprovalScope,
  ) {
    // Approval access reconnects only to the captured owner. Ordinary replay
    // reads cannot restore that connection themselves and must follow it.
    const pending = await options.controls.list(scope.sessionId);
    assertCurrent(socket);
    return pending.filter(
      (entry) =>
        entry.sessionId === scope.sessionId &&
        entry.request.requestId === scope.requestId,
    );
  }

  async function attachLegacy(
    socket: WebSocket,
    scope: BridgeApprovalScope,
  ): Promise<void> {
    assertCurrent(socket);
    await new Promise<void>((resolve, reject) => {
      void options.controls
        .attach(
          scope.requestId,
          scope.sessionId,
          delivery.requestSocket(scope.sessionId, scope.requestId),
          { toolApprovalController: options.legacyController() },
          resolve,
        )
        .then(resolve, reject);
    });
    assertCurrent(socket);
  }

  async function recover(socket: WebSocket, scope: BridgeApprovalScope) {
    const pending = await pendingForScope(socket, scope);
    const current = await replay(scope);
    assertCurrent(socket);
    const rollback = current.finalState
      ? undefined
      : delivery.bind(socket, scope.sessionId, scope.requestId);
    try {
      if (pending.some((entry) => entry.wait === undefined))
        await attachLegacy(socket, scope);
      const latest = await replay(scope);
      assertCurrent(socket);
      if (latest.finalState) delivery.release(scope.requestId);
      // A concurrent decision can stale this view, never the owner's decision checks.
      return {
        approvals: latest.finalState
          ? []
          : pending.map((entry) => ({
              request: entry.request,
              ...(entry.wait ? { wait: entry.wait } : {}),
            })),
        lifecycle: latest.lifecycle ?? null,
        finalState: latest.finalState,
      };
    } catch (error) {
      rollback?.();
      throw error;
    }
  }

  async function decide(
    socket: WebSocket,
    scope: BridgeApprovalScope,
    message: Record<string, unknown>,
  ) {
    const input = readApprovalDecision(message, scope);
    if (!input) throw new Error("invalid_approval_decision");
    const pending = (await pendingForScope(socket, scope)).find(
      (entry) => entry.request.approvalId === input.approvalId,
    );
    const current = await replay(scope);
    assertCurrent(socket);
    if (pending?.wait && input.waitId === undefined)
      throw new Error("invalid_approval_decision");
    // A durable receipt remains idempotent after its wait is consumed. Only the
    // owner can distinguish that receipt from a stale/replaced wait.
    if (input.waitId === undefined && !pending)
      return { result: { accepted: false, reason: "approval_not_pending" } };
    if (current.finalState) delivery.release(scope.requestId);
    const rollback = current.finalState
      ? undefined
      : delivery.bind(socket, scope.sessionId, scope.requestId);
    try {
      if (pending && !pending.wait) await attachLegacy(socket, scope);
      assertCurrent(socket);
      const result = await options.controls.decide(input);
      if (!result.accepted) rollback?.();
      return { result };
    } catch (error) {
      rollback?.();
      throw error;
    }
  }

  async function handleSteering(
    socket: WebSocket,
    message: Record<string, unknown>,
  ): Promise<boolean> {
    if (message.type !== "steer_request") return false;
    if (typeof message.requestId !== "string") return false;
    if (!delivery.has(socket, message.requestId) || !options.steer)
      return false;
    const steerId =
      typeof message.steerId === "string" ? message.steerId.trim() : "";
    const text = typeof message.text === "string" ? message.text.trim() : "";
    const result = await options.steer(message.requestId, { steerId, text });
    delivery.send(socket, {
      type: "steer_ack",
      requestId: message.requestId,
      steerId,
      ...(result.ok
        ? { accepted: true, acceptedSequence: result.update.sequence }
        : { accepted: false, reason: result.reason }),
    });
    return true;
  }

  return Object.freeze({
    async handleMessage(
      socket: WebSocket,
      message: Record<string, unknown>,
    ): Promise<boolean> {
      if (await handleSteering(socket, message)) return true;
      const recovering = message.type === "request.approvals.request";
      const deciding = message.type === "request.approval.decide.request";
      if (!recovering && !deciding) return false;
      const type = recovering
        ? "request.approvals.response"
        : "request.approval.decide.response";
      const identity = approvalResponseIdentity(message);
      try {
        assertCurrent(socket);
        const scope = readApprovalScope(message);
        if (!scope) throw new Error("invalid_approval_scope");
        const result = recovering
          ? await recover(socket, scope)
          : await decide(socket, scope, message);
        delivery.send(socket, { type, ...identity, ok: true, ...result });
      } catch (error) {
        const known =
          error instanceof Error && APPROVAL_ERRORS.has(error.message);
        delivery.send(socket, {
          type,
          ...identity,
          ok: false,
          error: known
            ? (error as Error).message
            : "approval_access_unavailable",
        });
      }
      return true;
    },
    async runRequest(
      socket: WebSocket,
      sessionId: string,
      requestId: string,
      run: (view: WebSocket) => ReturnType<RuntimeRequestHandler["handle"]>,
    ) {
      let rollback: (() => void) | undefined;
      try {
        rollback = delivery.bind(socket, sessionId, requestId);
      } catch {
        delivery.send(socket, {
          type: "failed",
          sessionId,
          requestId,
          error: "approval_delivery_unavailable",
        });
        return;
      }
      try {
        return await run(delivery.requestSocket(sessionId, requestId));
      } catch (error) {
        rollback();
        throw error;
      }
    },
    acceptsMode(message: Record<string, unknown>): boolean {
      return message.approvalMode === DURABLE_APPROVAL_MODE;
    },
    disconnect: (socket: WebSocket) => delivery.disconnect(socket),
    stop() {
      delivery.stop();
      unsubscribe();
    },
  });
}

const APPROVAL_ERRORS = new Set([
  "approval_request_not_found",
  "approval_scope_mismatch",
  "approval_connection_changed",
  "invalid_approval_scope",
  "invalid_approval_decision",
  "approval_delivery_capacity",
]);
