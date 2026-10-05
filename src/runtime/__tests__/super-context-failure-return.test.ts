import { expect, test, vi } from "vitest";
import { SuperContextFailure } from "../context/super-context-failure.js";
import { createRequestContextCompactionStore } from "../context/semantic-compaction/store.js";
import {
  createRoleExecutorRegistry,
  type RoleExecutor,
  type RoleExecutorInput,
} from "../orchestration/role-executors/index.js";
import type { RequestExecutionScope } from "../request/execution-scope.js";
import { containSuperContextFailures } from "../request/super-context-failure-executor.js";
import { composeRoleCallPlanChildObjective } from "../orchestration/role-calls/index.js";
import { projectSuperCompactedRequestToolResults } from "../context/super-request-tool-results-checkpoint.js";
import {
  buildRequestToolResultsMessage,
  projectRequestToolResults,
} from "../context/request-tool-results.js";
import { createSemanticCompactionSha256Fingerprint as hash } from "../context/semantic-compaction/contracts.js";
import { mixedWorkerFixture } from "./support/super-mixed-compaction-fixture.js";
import {
  createRootInvalidOutputLedger,
  createRootInvalidOutputRequest,
} from "./support/root-invalid-output-fixture.js";

function ownedFailure(
  input: RoleExecutorInput<RequestExecutionScope>,
  overrides = {},
) {
  return new SuperContextFailure(
    "request_tool_results_compaction_source_missing",
    {
      requestId: input.context.requestId,
      callId: input.call.callId,
      parentCallId: input.call.parentCallId,
      contractId: `delegated.${input.call.roleId}`,
      invocationAttempt: input.call.activationCount,
      sourceRevision: input.ledger.current().revision,
      modelStep: "worker.decision",
      phase: "projection",
      scopeId: `worker:${input.call.callId}:request-tool-results`,
      ...overrides,
    },
    new Error("original_projection_failure"),
  );
}

async function invoke(
  executor: RoleExecutor<RequestExecutionScope>,
  abortSignal?: AbortSignal,
) {
  const policy = "supervisor-worker-v1" as const;
  const ledger = await createRootInvalidOutputLedger(policy);
  const request = createRootInvalidOutputRequest(vi.fn(), policy, {
    contextCompactionStore: createRequestContextCompactionStore(),
    ...(abortSignal ? { abortSignal } : {}),
  });
  const registry = createRoleExecutorRegistry([
    containSuperContextFailures(executor, "delegated.worker"),
  ]);
  const head = ledger.current();
  const running = registry.invokeChild({
    requestId: request.requestId,
    context: request,
    ledger,
    expectedHead: head,
    callerCall: head.state.calls[0]!,
    roleId: "worker",
    objective: "Inspect bounded evidence.",
    workingDirectory: ".",
    turnCount: 1,
  });
  return { ledger, request, running };
}

test("owned projection failure returns once to its exact parent without quarantine", async () => {
  const { ledger, request, running } = await invoke({
    roleId: "worker",
    async execute(input) {
      throw ownedFailure(input);
    },
  });
  const returned = await running;
  expect(returned.execution).toMatchObject({
    kind: "terminal",
    outcome: "failed",
  });
  expect(returned.returnCommit.effect).toMatchObject({
    callerCallId: "call-1",
    childCallId: "call-2",
  });
  expect(ledger.current().state.activeCallId).toBe("call-1");
  expect(ledger.current().state.results).toHaveLength(1);
  expect(ledger.current().state.capabilityExecutions).toHaveLength(0);
  expect(request.contextCompactionStore!.snapshot!()).not.toHaveProperty(
    "invalidatedScopes",
  );
  expect(request.modelGatewayClient.invoke).not.toHaveBeenCalled();
});

test("a real rejected checkpoint projection returns through the canonical parent transaction", async () => {
  const { checkpoint } = await mixedWorkerFixture();
  const { ledger, request, running } = await invoke({
    roleId: "worker",
    async execute(input) {
      const head = input.ledger.current();
      const view = projectRequestToolResults({
        ledger: input.ledger,
        head,
        callId: input.call.callId,
        modelStep: "worker.decision",
      });
      projectSuperCompactedRequestToolResults(
        view,
        {
          ...checkpoint,
          requestId: input.context.requestId,
          currentRequestFingerprint: hash(input.context.prompt),
          callId: input.call.callId,
          objectiveFingerprint: hash(input.call.objective!),
          scopeId: `worker:${input.call.callId}:request-tool-results`,
          sourceRevision: head.revision + 1,
        },
        {
          requestId: input.context.requestId,
          prompt: input.context.prompt,
          head,
          store: input.context.contextCompactionStore!,
        },
        buildRequestToolResultsMessage(view),
      );
      throw new Error("must_reject_candidate");
    },
  });
  const returned = await running;
  expect(returned.execution.outcome).toBe("failed");
  expect(returned.execution.summary).toContain(
    "context_compaction_checkpoint_revision_invalid",
  );
  expect(returned.returnCommit.effect).toMatchObject({
    callerCallId: "call-1",
    childCallId: "call-2",
  });
  expect(ledger.current().state.results).toHaveLength(1);
  expect(request.contextCompactionStore!.snapshot!().checkpoints).toEqual([]);
  expect(request.contextCompactionStore!.snapshot!()).not.toHaveProperty(
    "invalidatedScopes",
  );
  expect(request.modelGatewayClient.invoke).not.toHaveBeenCalled();
});

test("a context failure cannot return against a head changed during its invocation", async () => {
  let failure: Error;
  const { ledger, running } = await invoke({
    roleId: "worker",
    async execute(input) {
      failure = ownedFailure(input);
      const changed = await input.ledger.apply({
        expectedHead: input.ledger.current(),
        command: {
          authority: "active_role",
          type: "begin_capability_execution",
          callId: input.call.callId,
          invocationAttempt: input.call.activationCount,
          capabilityId: "example.inspect",
          declaredEffect: "observation",
          intent: "Inspect evidence.",
          controlsJson: "{}",
        },
      });
      expect(changed.ok).toBe(true);
      throw failure;
    },
  });
  const caught = await running.catch((error: unknown) => error);
  expect(caught).toBe(failure!);
  expect(ledger.current().state.results).toEqual([]);
});

test.each([
  { callId: "foreign-call" },
  { parentCallId: "foreign-parent" },
  { requestId: "foreign-request" },
  { contractId: "direct.planner_advisory" },
  { modelStep: "execution.decision" },
])("foreign provenance escapes the child boundary: %j", async (overrides) => {
  let failure: Error;
  const { running } = await invoke({
    roleId: "worker",
    async execute(input) {
      failure = ownedFailure(input, overrides);
      throw failure;
    },
  });
  const caught = await running.catch((error: unknown) => error);
  expect(caught).toBe(failure!);
});

test("a matching message without owned typed provenance is not converted", async () => {
  const failure = new Error("request_tool_results_compaction_source_missing");
  const { running } = await invoke({
    roleId: "worker",
    async execute() {
      throw failure;
    },
  });
  await expect(running).rejects.toBe(failure);
});

test("cancellation takes precedence over an owned context failure", async () => {
  const cancelled = new Error("request_cancelled");
  const abort = new AbortController();
  abort.abort(cancelled);
  const { running } = await invoke(
    {
      roleId: "worker",
      async execute(input) {
        throw ownedFailure(input);
      },
    },
    abort.signal,
  );
  await expect(running).rejects.toBe(cancelled);
});

test("H2: nested Planner returns a failed Worker through each canonical parent", async () => {
  const ledger = await createRootInvalidOutputLedger();
  const request = createRootInvalidOutputRequest(
    vi.fn(),
    "supervisor-worker-v1",
    { contextCompactionStore: createRequestContextCompactionStore() },
  );
  const items = [{ title: "Inspect", objective: "Inspect bounded evidence." }];
  const worker: RoleExecutor<RequestExecutionScope> = {
    roleId: "worker",
    async execute(input) {
      throw ownedFailure(input);
    },
  };
  const planner: RoleExecutor<RequestExecutionScope> = {
    roleId: "planner",
    async execute(input) {
      if (input.continuation?.kind === "role_child") {
        expect(input.ledger.current().state.results.at(-1)?.outcome).toBe(
          "failed",
        );
        return {
          kind: "terminal",
          outcome: "failed",
          summary: "The bounded inspection could not finish.",
        };
      }
      return {
        kind: "invoke_role",
        roleId: "worker",
        objective: composeRoleCallPlanChildObjective(items, 8192)!,
        plannerPlan: {
          mode: "declare",
          plan: { summary: "Inspect evidence.", items },
          selectedItemIndexes: [0],
        },
      };
    },
  };
  const registry = createRoleExecutorRegistry([
    containSuperContextFailures(planner, "delegated.planner"),
    containSuperContextFailures(worker, "delegated.worker"),
  ]);
  const head = ledger.current();
  const returned = await registry.invokeChild({
    requestId: request.requestId,
    context: request,
    ledger,
    expectedHead: head,
    callerCall: head.state.calls[0]!,
    roleId: "planner",
    objective: "Inspect evidence.",
    workingDirectory: ".",
    turnCount: 1,
  });
  expect(returned.execution.outcome).toBe("failed");
  expect(
    ledger
      .current()
      .state.results.map((result) => [result.producerCallId, result.outcome]),
  ).toEqual([
    ["call-3", "failed"],
    ["call-2", "failed"],
  ]);
  expect(ledger.current().state.activeCallId).toBe("call-1");
  expect(ledger.current().state.capabilityExecutions).toHaveLength(0);
  expect(request.modelGatewayClient.invoke).not.toHaveBeenCalled();
});
