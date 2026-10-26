import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { invokeSuperCompactionStageText } from "../context/super-compaction/model-call.js";
import { resolveModelOutputFailure } from "../model/invalid-output-failure.js";
import { RawModelValidationError } from "../model/invoke-raw-step.js";
import type { ModelStepInvocationInput } from "../model/model-step-port.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import {
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
import { executeRoleWithModelOutputFailure } from "../orchestration/role-executors/activation/model-output-failure.js";
import type { BoundRequestModelInvocationContext } from "../request/contracts.js";

const STAGES = ["coverage", "content", "merge", "continuation"] as const;
type Stage = (typeof STAGES)[number];
const ROLES = ["planner", "worker", "reviewer"] as const;
const EMPTY_OUTPUTS = ["", " \n\t "] as const;
const ISSUE = {
  code: "super_compaction_output_empty",
  path: "$",
  message: "Compaction output must contain non-whitespace text.",
};

function createStageInvocation(
  stage: Stage,
  text: string,
  signal = new AbortController().signal,
) {
  const invocations: ModelStepInvocationInput<unknown>[] = [];
  const request = {
    modelSteps: {
      async invoke<T>(input: ModelStepInvocationInput<T>): Promise<T> {
        invocations.push(input);
        return input.accept(text, {
          outputLength: text.length,
          terminalEventCount: 1,
          providerCompletionReason: "stop",
        }, signal);
      },
    },
  } as BoundRequestModelInvocationContext;
  const invoke = () => invokeSuperCompactionStageText({
    request,
    stage,
    baseMessages: [{
      role: "user",
      content: JSON.stringify({
        kind: "runtime_super_compaction_capsule_v1",
        sourceSlice: { content: "Observed bounded evidence." },
      }),
    }],
    maxCharacters: 100,
  });
  return {
    invoke,
    invocations,
    async execute() {
      return { kind: "terminal", outcome: "completed", summary: await invoke() } as const;
    },
  };
}

async function createLedger() {
  const ledger = createRoleCallLedger({
    requestId: "empty-super-compaction",
    policy: {
      limits: {
        maxDepth: 4,
        maxCalls: 8,
        maxCapabilityExecutions: 8,
        maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
        maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
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

function invokeChild(ledger: RoleCallLedger, executor: RoleExecutor<undefined>) {
  const head = ledger.current();
  return createRoleExecutorRegistry([executor]).invokeChild({
    requestId: "empty-super-compaction",
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

describe("empty successful SUPER compaction output", () => {
  test.each(STAGES.flatMap((stage) =>
    EMPTY_OUTPUTS.map((text) => ({ stage, text })),
  ))("$stage binds empty output to its validation contract", async ({ stage, text }) => {
    const invocation = createStageInvocation(stage, text);
    const error = await invocation.invoke().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RawModelValidationError);
    expect(error).toMatchObject({
      reason: `invalid_super_compaction_${stage}_output`,
      stage: `raw_compaction_${stage}`,
      issues: [ISSUE],
    });
    expect(resolveModelOutputFailure(error)).toMatchObject({
      code: `invalid_super_compaction_${stage}_output`,
      modelStep: `super.compact.${stage}`,
      validationStage: `raw_compaction_${stage}`,
    });
    expect(invocation.invocations).toHaveLength(1);
  });

  test.each(STAGES.flatMap((stage) => ROLES.flatMap((roleId) =>
    EMPTY_OUTPUTS.map((text) => ({ stage, roleId, text })),
  )))("$roleId returns $stage failure to its exact parent", async ({ stage, roleId, text }) => {
    const ledger = await createLedger();
    const invocation = createStageInvocation(stage, text);
    const returned = await invokeChild(ledger, { roleId, execute: invocation.execute });
    expect(returned.execution).toMatchObject({ kind: "terminal", outcome: "failed" });
    expect(returned.execution).not.toHaveProperty("value");
    expect(returned.execution).not.toHaveProperty("receipt");
    expect(JSON.parse(returned.execution.summary)).toEqual({
      kind: "runtime_role_model_output_failure_v1",
      authority: "runtime_validation",
      presenceEffect: "passive_failure_not_work_or_review_evidence",
      callId: "call-2",
      parentCallId: "call-1",
      roleId,
      reason: `invalid_super_compaction_${stage}_output`,
      modelStep: `super.compact.${stage}`,
      validationStage: `raw_compaction_${stage}`,
    });
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
    const results = ledger.current().state.results;
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ roleId, producerCallId: "call-2", outcome: "failed" });
    if (roleId === "reviewer") expect(results[0]).not.toHaveProperty("receipt");
    expect(invocation.invocations).toHaveLength(1);
  });

  test.each(STAGES)("%s keeps root failure outside delegated containment", async (stage) => {
    const ledger = await createLedger();
    const head = ledger.current();
    const invocation = createStageInvocation(stage, "");
    await expect(executeRoleWithModelOutputFailure(
      { roleId: "worker", execute: invocation.execute },
      { context: undefined, call: head.state.calls[0]!, ledger, availableChildRoleIds: [] },
      ROLE_CALL_RESULT_MAX_LENGTH,
      "empty-super-compaction",
    )).rejects.toMatchObject({
      name: "RawModelValidationError",
      reason: `invalid_super_compaction_${stage}_output`,
    });
    expect(ledger.current()).toBe(head);
    expect(invocation.invocations).toHaveLength(1);
  });

  test.each(STAGES)("%s preserves cancellation before empty-output validation", async (stage) => {
    const ledger = await createLedger();
    const controller = new AbortController();
    const reason = new DOMException("Request cancelled.", "AbortError");
    controller.abort(reason);
    const invocation = createStageInvocation(stage, " \n", controller.signal);
    await expect(invokeChild(ledger, {
      roleId: "worker", execute: invocation.execute,
    })).rejects.toBe(reason);
    expect(ledger.current().state.results).toHaveLength(0);
    expect(invocation.invocations).toHaveLength(1);
  });

  test.each(STAGES.flatMap((stage) => [
    { stage, error: new Error(`invalid_super_compaction_${stage}_output`) },
    { stage, error: new RawModelValidationError({
      reason: `invalid_super_compaction_${stage}_output`,
      stage: "raw_result",
      issues: [ISSUE],
    }) },
  ]))("$stage leaves unbound errors unrecognized", async ({ error }) => {
    const ledger = await createLedger();
    expect(resolveModelOutputFailure(error)).toBeUndefined();
    await expect(invokeChild(ledger, {
      roleId: "worker",
      async execute() { throw error; },
    })).rejects.toBe(error);
    expect(ledger.current().state.results).toHaveLength(0);
  });
});
