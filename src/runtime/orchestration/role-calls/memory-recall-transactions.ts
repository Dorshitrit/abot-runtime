import type { RoleCallLedger } from "./contracts.js";
import type {
  RoleMemoryRecallIdentity,
  RoleMemoryRecallTransactions,
} from "./memory-recall-contract.js";
import { requireEffect } from "./transaction-effect.js";

export function createMemoryRecallTransactions(
  apply: RoleCallLedger["apply"],
): RoleMemoryRecallTransactions {
  return Object.freeze({
    async beginMemoryRecall(input) {
      return requireEffect(
        await apply({
          expectedHead: input.expectedHead,
          command: {
            authority: "active_role",
            type: "begin_memory_recall",
            callId: input.callId,
            invocationAttempt: input.invocationAttempt,
            steeringVersion: input.steeringVersion,
            query: input.query,
          },
        }),
        "memory_recall_begun",
        "memory_recall_transition_invalid",
        (effect) => matchesMemoryRecallIdentity(effect, input),
      );
    },
    async settleMemoryRecall(input) {
      return requireEffect(
        await apply({
          expectedHead: input.expectedHead,
          command: {
            authority: "runtime",
            type: "settle_memory_recall",
            callId: input.callId,
            invocationAttempt: input.invocationAttempt,
            steeringVersion: input.steeringVersion,
            recallId: input.recallId,
            result: input.result,
          },
        }),
        "memory_recall_settled",
        "memory_recall_transition_invalid",
        (effect) => matchesMemoryRecallSettlement(effect, input),
      );
    },
  });
}

function matchesMemoryRecallIdentity(
  effect: RoleMemoryRecallIdentity,
  input: RoleMemoryRecallIdentity,
): boolean {
  if (effect.callId !== input.callId) return false;
  if (effect.invocationAttempt !== input.invocationAttempt) return false;
  return effect.steeringVersion === input.steeringVersion;
}

function matchesMemoryRecallSettlement(
  effect: RoleMemoryRecallIdentity & { recallId: string },
  input: RoleMemoryRecallIdentity & { recallId: string },
): boolean {
  if (!matchesMemoryRecallIdentity(effect, input)) return false;
  return effect.recallId === input.recallId;
}
