import { workerEvidenceDecision } from "./support/worker-evidence-script.js";
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
import { resolveRoleActivationBudget } from "../orchestration/role-calls/activation-budget.js";
import { supervisorFormatName } from "./support/supervisor-model-phases.js";
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
    test("reserves the existing activation bound before extra retrieval after the required entry", async () => {
      let decisions = 0;
      const harness = createMemoryRecallHarness({
        policy,
        classifyProcedure: () => ({ requiresProcedure: true }),
        delegate: () => ({ action: "invoke_role", roleId: "worker", objective: "Identify the saved preference needed by the answer." }),
        decide(input) {
          if (supervisorFormatName(input) === "supervisor_working_directory") return JSON.stringify({ workingDirectory: "." });
          if (input.modelStep === "worker.evidence") return workerEvidenceDecision(input, false);
          if (input.modelStep === "worker.result") return "The root needs the stored formatting preference.";
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
            maxCalls: policy === "supervisor-worker-v1" ? 2 : 1,
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
      const maximum = resolveRoleActivationBudget(ledger.current().state, ledger.current().policy)
        .maximumAcceptedActivationsPerCall;
      const entryActivations = policy === "supervisor-worker-v1" ? 2 : 1;
      const expectedRecalls = maximum - entryActivations;
      await expect(
        runRootExecutionKernel({
          request: harness.request,
          ledger,
        }),
      ).rejects.toThrow("role_activation_limit_exceeded");
      expect(decisions).toBe(expectedRecalls + 1);
      expect(harness.memory.retrieve).toHaveBeenCalledTimes(expectedRecalls);
      expect(ledger.current().state.memoryRecalls).toHaveLength(expectedRecalls);
      expect(ledger.current().state.calls).toHaveLength(entryActivations);
      expect(ledger.current().state.calls[0]).toMatchObject({
        callId: "call-1",
        activationCount: maximum,
        parentCallId: null,
      });
      expect(ledger.current().state.results).toHaveLength(entryActivations - 1);
      if (policy === "supervisor-worker-v1") expect(ledger.current().state.calls[1])
        .toMatchObject({ roleId: "worker", parentCallId: "call-1", status: "completed" });
      expect(ledger.current().state.capabilityExecutions).toEqual([]);
      expect(harness.getAdapters).toHaveBeenCalledTimes(entryActivations - 1);
    });
  },
);
