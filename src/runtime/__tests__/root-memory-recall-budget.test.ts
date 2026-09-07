import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import {
  createRoleCallLedger,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  resolveRoleCallTransactions,
} from "../orchestration/role-calls/index.js";
import { runRootExecutionKernel } from "../request/root-execution-kernel.js";
import {
  createMemoryRecallHarness,
  RECALL_QUERY,
  type RecallPolicy,
} from "./support/memory-recall-runner.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

describe.each<RecallPolicy>(["supervisor-worker-v1", "execution-agent-v1"])(
  "%s memory recall activation budget",
  (policy) => {
    test("reserves the existing activation bound before retrieval and opens no child or capability", async () => {
      let decisions = 0;
      const harness = createMemoryRecallHarness({
        policy,
        decide() {
          decisions += 1;
          return {
            action: "recall_memory",
            query: RECALL_QUERY,
            ...(decisions === 1
              ? { acknowledgement: "I will check the saved preference." }
              : {}),
          };
        },
      });
      const ledger = createRoleCallLedger({
        requestId: harness.request.requestId,
        policy: {
          authority: harness.request.executionPolicy.authority,
          limits: {
            maxDepth: 1,
            maxCalls: 1,
            maxCapabilityExecutions: 1,
            maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
            maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
            maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
          },
        },
      });
      const created = await resolveRoleCallTransactions(ledger).createRoot({
        expectedHead: ledger.current(),
      });
      expect(created.ok).toBe(true);
      await expect(
        runRootExecutionKernel({
          request: harness.request,
          ledger,
        }),
      ).rejects.toThrow("role_activation_limit_exceeded");
      expect(decisions).toBe(3);
      expect(harness.memory.retrieve).toHaveBeenCalledTimes(2);
      expect(ledger.current().state.calls).toHaveLength(1);
      expect(ledger.current().state.calls[0]).toMatchObject({
        callId: "call-1",
        activationCount: 3,
        parentCallId: null,
      });
      expect(ledger.current().state.results).toEqual([]);
      expect(ledger.current().state.capabilityExecutions).toEqual([]);
      expect(harness.getAdapters).not.toHaveBeenCalled();
    });
  },
);
