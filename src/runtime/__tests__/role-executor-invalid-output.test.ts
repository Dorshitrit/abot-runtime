import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { StructuredModelInvalidOutputError } from "../model/invoke-structured-step.js";
import { RawModelValidationError } from "../model/invoke-raw-step.js";
import { ModelOutputIncompleteError } from "../model/provider-completion.js";
import { ModelStepTimeoutError } from "../steps/model-step-timeout.js";
import {
  composeRoleCallPlanChildObjective,
  createRoleCallLedger,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  type RoleCallLedger,
} from "../orchestration/role-calls/index.js";
import {
  createRoleExecutorRegistry,
  type RoleExecutor,
} from "../orchestration/role-executors/index.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type { ModelStep } from "../../shared/model-steps.js";

const PRIVATE_OUTPUT = "Untrusted rejected model text must stay private.";

function structuredFailure(reason: string, step: ModelStep) {
  return new StructuredModelInvalidOutputError(reason, step, {
    validationStage: "shape",
    issues: [
      { code: "shape_invalid", path: "decision", message: PRIVATE_OUTPUT },
    ],
    repairAttempts: 2,
    repeatedInvalidOutput: true,
  });
}

function compactionFailure() {
  return new StructuredModelInvalidOutputError(
    "invalid_context_compaction_output",
    "context.compact",
    {
      validationStage: "shape",
      issues: [
        {
          code: "context_compaction_output_not_json",
          path: "$",
          message: PRIVATE_OUTPUT,
        },
      ],
      repairAttempts: 2,
      repeatedInvalidOutput: true,
    },
  );
}

function workerResultFailure() {
  return new RawModelValidationError({
    stage: "raw_result",
    reason: "invalid_worker_result",
    issues: [
      { code: "worker_result_empty", path: "result", message: PRIVATE_OUTPUT },
    ],
  });
}

function incompleteOutput(modelStep?: ModelStep) {
  return new ModelOutputIncompleteError(
    { outputLength: PRIVATE_OUTPUT.length, providerCompletionReason: "length" },
    modelStep,
  );
}

function timeoutOutput(modelStep: ModelStep) {
  return new ModelStepTimeoutError(
    modelStep.replace(".", "_") + "_timeout",
    modelStep,
  );
}

async function createLedger(maxResultChars = ROLE_CALL_RESULT_MAX_LENGTH) {
  const ledger = createRoleCallLedger({
    requestId: "invalid-child",
    policy: {
      limits: {
        maxDepth: 4,
        maxCalls: 8,
        maxCapabilityExecutions: 8,
        maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
        maxResultChars,
        maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
      },
    },
  });
  await ledger.apply({
    expectedHead: ledger.current(),
    command: { authority: "runtime", type: "create_root" },
  });
  return ledger;
}

async function invokeChild(
  ledger: RoleCallLedger,
  executor: RoleExecutor<undefined>,
) {
  const registry = createRoleExecutorRegistry([executor]);
  const head = ledger.current();
  return registry.invokeChild({
    requestId: "invalid-child",
    context: undefined,
    callerCall: head.state.calls[0]!,
    ledger,
    expectedHead: head,
    roleId: executor.roleId,
    objective: "Complete this bounded objective.",
    ...(executor.roleId === "reviewer" ? {} : { workingDirectory: "." }),
    turnCount: 1,
  });
}

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

describe("exhausted child model output", () => {
  test.each([
    [
      "planner",
      () => structuredFailure("invalid_planner_decision", "planner.decision"),
    ],
    [
      "worker",
      () => structuredFailure("invalid_worker_decision", "worker.decision"),
    ],
    ["worker", workerResultFailure],
    ["worker", () => incompleteOutput("worker.decision")],
    ["worker", () => incompleteOutput("worker.result")],
    ["planner", () => incompleteOutput("planner.decision")],
    ["reviewer", () => incompleteOutput("reviewer.decision")],
    ["planner", () => incompleteOutput("planner.graph")],
    ["reviewer", () => incompleteOutput("auditor.decision")],
    ["worker", () => timeoutOutput("worker.decision")],
    ["worker", () => timeoutOutput("worker.result")],
    ["planner", () => timeoutOutput("planner.decision")],
    ["reviewer", () => timeoutOutput("reviewer.decision")],
    ["planner", () => timeoutOutput("planner.graph")],
    ["reviewer", () => timeoutOutput("auditor.decision")],
    [
      "worker",
      () => structuredFailure("invalid_worker_decision", "capability.controls"),
    ],
    ["planner", compactionFailure],
    ["worker", compactionFailure],
    ["reviewer", compactionFailure],
    [
      "reviewer",
      () => structuredFailure("invalid_reviewer_decision", "reviewer.decision"),
    ],
  ] as const)(
    "%s returns a passive failure to its exact caller",
    async (roleId, createError) => {
      const ledger = await createLedger();
      const returned = await invokeChild(ledger, {
        roleId,
        async execute() {
          throw createError();
        },
      });
      expect(returned.execution).toMatchObject({
        kind: "terminal",
        outcome: "failed",
      });
      expect(returned.execution).not.toHaveProperty("value");
      expect(returned.execution).not.toHaveProperty("receipt");
      expect(JSON.parse(returned.execution.summary)).toMatchObject({
        kind: "runtime_role_model_output_failure_v1",
        authority: "runtime_validation",
        presenceEffect: "passive_failure_not_work_or_review_evidence",
        callId: "call-2",
        parentCallId: "call-1",
        roleId,
      });
      expect(returned.execution.summary).not.toContain(PRIVATE_OUTPUT);
      expect(returned.returnCommit.effect).toMatchObject({
        type: "child_returned",
        callerCallId: "call-1",
        childCallId: "call-2",
        resultRef: "result-1",
      });
      expect(ledger.current().state).toMatchObject({
        phase: "running",
        activeCallId: "call-1",
        rootResponse: null,
      });
      const storedResult = ledger.current().state.results[0]!;
      expect(storedResult).toMatchObject({
        roleId,
        producerCallId: "call-2",
        outcome: "failed",
      });
      if (roleId === "reviewer") {
        expect(storedResult).not.toHaveProperty("receipt");
        return;
      }
      expect(storedResult.receipt).toMatchObject({
        kind: "work_result_v1",
        producerCallId: "call-2",
        callerCallId: "call-1",
      });
    },
  );

  test("a legal tiny result limit still returns failed without inventing evidence", async () => {
    const ledger = await createLedger(1);
    const returned = await invokeChild(ledger, {
      roleId: "reviewer",
      async execute() {
        throw structuredFailure(
          "invalid_reviewer_decision",
          "reviewer.decision",
        );
      },
    });
    expect(returned.execution).toEqual({
      kind: "terminal",
      outcome: "failed",
      summary: "I",
    });
    expect(ledger.current().state.results[0]).not.toHaveProperty("receipt");
  });

  test.each([
    new Error("provider_stream_error"),
    new Error("output_incomplete"),
    new Error("worker_result_timeout"),
    { code: "worker_result_timeout", modelStep: "worker.result" },
    timeoutOutput("supervisor.decision"),
    timeoutOutput("reviewer.decision"),
    timeoutOutput("planner.graph"),
    timeoutOutput("auditor.decision"),
    timeoutOutput("tool_payload.raw"),
    incompleteOutput(),
    incompleteOutput("supervisor.decision"),
    incompleteOutput("reviewer.decision"),
    incompleteOutput("tool_payload.raw"),
    new Error("invalid_worker_decision"),
    new DOMException("Request cancelled.", "AbortError"),
    structuredFailure("invalid_supervisor_decision", "supervisor.decision"),
    structuredFailure("unknown_contract_invalid", "worker.decision"),
  ])(
    "preserves provider, cancellation, invariant and foreign output errors",
    async (error) => {
      const ledger = await createLedger();
      await expect(
        invokeChild(ledger, {
          roleId: "worker",
          async execute() {
            throw error;
          },
        }),
      ).rejects.toBe(error);
      expect(ledger.current().state.results).toHaveLength(0);
      expect(ledger.current().state.activeCallId).toBe("call-2");
    },
  );

  test("does not normalize a malformed runtime executor result into model failure", async () => {
    const ledger = await createLedger();
    await expect(
      invokeChild(ledger, {
        roleId: "worker",
        async execute() {
          return { kind: "terminal", outcome: "completed", summary: "" };
        },
      }),
    ).rejects.toThrow("role_executor_result_invalid:worker:summary_invalid");
    expect(ledger.current().state.results).toHaveLength(0);
  });

  test("refuses a synthetic failure when the executor changed canonical state", async () => {
    const ledger = await createLedger();
    const item = {
      title: "Produce result",
      objective: "Produce one bounded result.",
    };
    const objective = composeRoleCallPlanChildObjective(
      [item],
      ROLE_CALL_OBJECTIVE_MAX_LENGTH,
    )!;
    await expect(
      invokeChild(ledger, {
        roleId: "planner",
        async execute({ call }) {
          const opened = await ledger.apply({
            expectedHead: ledger.current(),
            command: {
              authority: "active_role",
              type: "open_child",
              callerCallId: call.callId,
              roleId: "worker",
              objective,
              plannerPlan: {
                mode: "declare",
                plan: { summary: "Produce the result.", items: [item] },
                selectedItemIndexes: [0],
              },
            },
          });
          expect(opened.ok).toBe(true);
          throw structuredFailure(
            "invalid_planner_decision",
            "planner.decision",
          );
        },
      }),
    ).rejects.toThrow(
      "role_executor_result_invalid:planner:terminal_state_changed",
    );
    expect(ledger.current().state.results).toHaveLength(0);
    expect(ledger.current().state.activeCallId).toBe("call-3");
  });
});
