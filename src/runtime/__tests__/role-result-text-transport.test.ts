import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  createRoleCallLedger,
  isRoleCallResultText,
  projectRoleCallDependencyResults,
  projectRoleChildReturnContext,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  validateRoleCallCandidate,
  type RoleCallLedger,
} from "../orchestration/role-calls/index.js";
import {
  createRoleExecutorRegistry,
  type RoleExecutor,
} from "../orchestration/role-executors/index.js";
import { normalizeRoleExecutorActivationResult } from "../orchestration/role-executors/activation/result-normalization.js";
import {
  createWorkerCapabilityPayloadAuthor,
  EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
  type WorkerCapabilityPayloadModelPort,
} from "../orchestration/worker-capabilities/index.js";
import { normalizeCompletedAdapterExecution } from "../orchestration/worker-capabilities/execution/adapter-result-normalization.js";
import { projectWorkerCapabilityPayloadSourceProvenance } from "../orchestration/worker-capabilities/payload-source-provenance.js";
import { buildSupervisorContinuationMessages } from "../steps/supervisor-decision/resume.js";
import { projectWorkerPayloadDependencyResults } from "../steps/worker-decision/payload-dependency-results.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";

const REQUEST_ID = "role-result-text-transport";
const LARGE_RESULT = "Settled source detail.\n".repeat(1_000);

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

async function createLedger() {
  const ledger = createRoleCallLedger({
    requestId: REQUEST_ID,
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
  const rooted = await ledger.apply({
    expectedHead: ledger.current(),
    command: { authority: "runtime", type: "create_root" },
  });
  expect(rooted.ok).toBe(true);
  return ledger;
}

async function returnChild(
  ledger: RoleCallLedger,
  roleId: "worker" | "planner",
  outcome: "completed" | "failed",
) {
  const executor: RoleExecutor<undefined> = {
    roleId,
    execute: async () => ({ kind: "terminal", outcome, summary: LARGE_RESULT }),
  };
  const head = ledger.current();
  return createRoleExecutorRegistry([executor]).invokeChild({
    requestId: REQUEST_ID,
    context: undefined,
    callerCall: head.state.calls[0]!,
    ledger,
    expectedHead: head,
    roleId,
    objective: "Return the source details needed by the caller.",
    workingDirectory: ".",
    turnCount: 1,
  });
}

test.each([
  ["worker", "completed"],
  ["worker", "failed"],
  ["planner", "completed"],
  ["planner", "failed"],
] as const)(
  "preserves a long %s %s result through the ledger and caller resume",
  async (roleId, outcome) => {
    expect(LARGE_RESULT.length).toBeGreaterThan(ROLE_CALL_RESULT_MAX_LENGTH);
    const ledger = await createLedger();
    const returned = await returnChild(ledger, roleId, outcome);
    const head = ledger.current();
    const summary = LARGE_RESULT.trim();
    expect(returned.execution.summary).toBe(summary);
    expect(head.state.results[0]).toMatchObject({ roleId, outcome, summary });
    expect(head.state.results[0]!.receipt?.kind).toBe("work_result_v1");
    expect(
      validateRoleCallCandidate({ state: head.state, policy: head.policy }),
    ).toEqual([]);
    const resume = projectRoleChildReturnContext(ledger, returned.returnCommit);
    const messages = buildSupervisorContinuationMessages({
      resume,
      currentCallId: "call-1",
      currentInvocationAttempt: head.state.calls[0]!.activationCount,
    });
    expect(JSON.parse(messages[1]!.content!)).toMatchObject({
      kind: "runtime_child_result",
      summary,
      outcome,
      roleId,
    });
  },
);

test.each([undefined, null, 12, {}, "", " \n\t"])(
  "still rejects missing or empty result text: %j",
  (value) => {
    expect(isRoleCallResultText(value)).toBe(false);
    expect(
      normalizeRoleExecutorActivationResult(
        {
          kind: "terminal",
          outcome: "completed",
          summary: value,
        } as unknown as Parameters<
          typeof normalizeRoleExecutorActivationResult
        >[0],
        ROLE_CALL_OBJECTIVE_MAX_LENGTH,
      ),
    ).toEqual({ ok: false, issueCode: "summary_invalid" });
  },
);

test("preserves a long sibling result through dependency projection and payload authoring", async () => {
  const ledger = await createLedger();
  await returnChild(ledger, "worker", "completed");
  const opened = await ledger.apply({
    expectedHead: ledger.current(),
    command: {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Write a report from the dependency result.",
      workingDirectory: ".",
      dependencyResultRefs: ["result-1"],
    },
  });
  expect(opened.ok).toBe(true);
  const head = ledger.current();
  const call = head.state.calls.at(-1)!;
  const dependencyResults = projectWorkerPayloadDependencyResults(
    projectRoleCallDependencyResults(head, call),
  );
  expect(dependencyResults[0]!.summary).toBe(LARGE_RESULT.trim());
  const assignmentProvenance = projectWorkerCapabilityPayloadSourceProvenance({
    ledger,
    head,
    call,
  });
  const invoke = vi.fn<WorkerCapabilityPayloadModelPort["invoke"]>(
    async () => "Report content.",
  );
  const author = createWorkerCapabilityPayloadAuthor({
    requestId: REQUEST_ID,
    abortSignal: new AbortController().signal,
    model: { invoke },
  });
  const result = await author.author({
    call,
    assignmentProvenance,
    authoringObjective:
      "Write the report body from the accepted source details.",
    executionId: "capability-execution-1",
    descriptor: {
      capabilityId: "test.write_report",
      summary: "Write the accepted report.",
      effect: "mutation",
      controls: EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
      requiresPayloadAuthoringObjective: true,
    },
    controls: {},
    dependencyResults,
    settledCapabilityResults: [],
    contract: {
      instructions: "Return the report body.",
      minBytes: 1,
      maxBytes: 100,
    },
  });
  expect(result).toEqual({ status: "authored", body: "Report content." });
  expect(invoke).toHaveBeenCalledOnce();
  expect(invoke.mock.calls[0]![0]).toMatchObject({
    context: { dependencyResults: [{ summary: LARGE_RESULT.trim() }] },
  });
});

test("keeps the independent adapter summary envelope bounded", () => {
  expect(
    normalizeCompletedAdapterExecution(
      {
        outcome: "succeeded",
        observedEffect: "observation",
        summary: LARGE_RESULT,
      },
      "observation",
    ),
  ).toMatchObject({
    ok: false,
    issueCode: "adapter_result_summary_invalid",
  });
});
