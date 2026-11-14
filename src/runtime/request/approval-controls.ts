import type WebSocket from "ws";
import type { RuntimeRequestOptions } from "../composition.js";
import type {
  LocalPendingToolApproval,
  LocalToolApprovalDecisionInput,
  LocalToolApprovalDecisionResult,
} from "../local-host/request-approval-contracts.js";

/** Optional owner access; transport views never store or resume continuations. */
export type RuntimeRequestApprovalControls = Readonly<{
  list(sessionId?: string): Promise<LocalPendingToolApproval[]>;
  decide(
    input: LocalToolApprovalDecisionInput,
  ): Promise<LocalToolApprovalDecisionResult>;
  attach(
    requestId: string,
    sessionId: string,
    socket: WebSocket,
    options?: RuntimeRequestOptions,
    onAccepted?: () => void,
  ): Promise<void>;
  subscribeEvents(
    listener: (event: Record<string, unknown>) => void,
  ): () => void;
}>;
