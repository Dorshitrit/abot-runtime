import type { LongTermMemoryRecord } from "../../long-term-memory/contracts.js";
import type {
  RoleCallTransactionInput,
  RoleCallTransactionResult,
} from "./contracts.js";

export const ROLE_MEMORY_RECALL_QUERY_MAX_LENGTH = 1_024;
export const ROLE_MEMORY_RECALL_RECORD_LIMIT_MAX = 6;
export const ROLE_MEMORY_RECALL_RESULT_MAX_LENGTH = 6_000;
export const ROLE_MEMORY_RECALL_REASON_MAX_LENGTH = 256;

export type RoleMemoryRecallResult = Readonly<{
  outcome: "found" | "empty" | "unavailable" | "superseded";
  records: readonly LongTermMemoryRecord[];
  omittedRecordCount: number;
  reason?: string;
}>;

export type RoleMemoryRecallIdentity = Readonly<{
  callId: string;
  invocationAttempt: number;
  steeringVersion: number;
}>;

export type RoleMemoryRecall = RoleMemoryRecallIdentity &
  Readonly<{
    recallId: string;
    completedChildCount: number;
    query: string;
  }> &
  (
    | Readonly<{ status: "pending"; result?: undefined }>
    | Readonly<{ status: "settled"; result: RoleMemoryRecallResult }>
  );

export type BeginRoleMemoryRecallCommand = RoleMemoryRecallIdentity &
  Readonly<{
    authority: "active_role";
    type: "begin_memory_recall";
    query: string;
  }>;

export type SettleRoleMemoryRecallCommand = RoleMemoryRecallIdentity &
  Readonly<{
    authority: "runtime";
    type: "settle_memory_recall";
    recallId: string;
    result: RoleMemoryRecallResult;
  }>;

export type RoleMemoryRecallCommand =
  | BeginRoleMemoryRecallCommand
  | SettleRoleMemoryRecallCommand;

export type RoleMemoryRecallCommitEffect = RoleMemoryRecallIdentity &
  Readonly<{ recallId: string }> &
  (
    | Readonly<{ type: "memory_recall_begun" }>
    | Readonly<{ type: "memory_recall_settled" }>
  );

export type RoleMemoryRecallTransactions = Readonly<{
  beginMemoryRecall(
    input: RoleCallTransactionInput<BeginRoleMemoryRecallCommand>,
  ): Promise<
    RoleCallTransactionResult<
      "memory_recall_begun",
      "memory_recall_transition_invalid"
    >
  >;
  settleMemoryRecall(
    input: RoleCallTransactionInput<SettleRoleMemoryRecallCommand>,
  ): Promise<
    RoleCallTransactionResult<
      "memory_recall_settled",
      "memory_recall_transition_invalid"
    >
  >;
}>;
