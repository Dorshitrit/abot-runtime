import { afterEach, beforeEach, expect, test } from "vitest";
import { FILE_PAYLOAD_TOOL_HANDOFF, FILE_PAYLOAD_TOOL_REQUESTED } from "../capabilities/file-payload-tool-handoff.js";
import type { RoleCapabilityDeclaredEffect } from "../orchestration/role-calls/index.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { projectFilePayloadContinuation } from "../request/execution-file-payload/continuation.js";
import { resumeFilePayloadAuthoring } from "../request/execution-file-payload/resume.js";
import { runRequestRunner } from "../request/runner.js";
import { fileContinuationFixture } from "./support/execution-file-continuation-fixture.js";

type Fixture = Awaited<ReturnType<typeof fileContinuationFixture>>;

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

async function nestedFixture(): Promise<Fixture> {
  const f = await fileContinuationFixture();
  for (const capabilityId of ["nested.outer", "nested.inner"]) {
    f.capabilities.push({ ...f.capabilities[0]!, capabilityId, summary: capabilityId, effect: "observation" });
  }
  await f.handoff(["nested.outer"]);
  return f;
}

/** Keep current descriptors observational while admitting the saved declaration through the reducer. */
async function nestedHandoff(f: Fixture, capabilityId: string, nextCapabilityId: string,
  declaredEffect: RoleCapabilityDeclaredEffect = "observation") {
  const invocationAttempt = f.call().activationCount;
  const path = `${capabilityId}.txt`;
  const executionId = await f.begin(capabilityId, path, declaredEffect);
  await f.settle(executionId, {
    kind: "generic_capability_result_v1", authority: "capability_adapter", status: "executed", ok: false,
    payload: { kind: "runtime_capability_rejection_v1", authority: "runtime", status: "rejected",
      stage: "before_external_execution", code: FILE_PAYLOAD_TOOL_REQUESTED,
      message: "The accepted operation requested an observation.", fileAuthoringContinuation: {
        kind: FILE_PAYLOAD_TOOL_HANDOFF, invocationAttempt, steeringVersion: 0,
        pending: { capabilityId, controls: { path }, authoringObjective: "Complete the accepted bounded operation." },
        toolDecision: JSON.stringify({ decision: { action: "invoke_capability", capabilityId: nextCapabilityId,
          selectionControls: { path: `${nextCapabilityId}.txt` } } }),
      } },
  }, true);
}

async function settleNestedOperation(f: Fixture, capabilityId: string,
  declaredEffect: RoleCapabilityDeclaredEffect = "observation") {
  await f.settle(await f.begin(capabilityId, `${capabilityId}.txt`, declaredEffect));
}

function projectNestedContinuation(f: Fixture) {
  return projectFilePayloadContinuation({ executions: f.ledger.current().state.capabilityExecutions,
    call: f.call(), capabilities: f.capabilities, steeringVersion: 0 });
}

async function expectNestedContinuationRejected(f: Fixture, pendingCapabilityId = "document.write") {
  const before = JSON.stringify(f.ledger.current());
  expect(projectNestedContinuation(f)).toMatchObject({
    pending: { capabilityId: pendingCapabilityId }, observationToolsOnly: false,
  });
  await expect(resumeFilePayloadAuthoring(f.request, {
    head: f.ledger.current(), call: f.call(), steeringSnapshot: f.steering.snapshot(),
  })).rejects.toThrow("execution_file_handoff_incompatible");
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.restore).not.toHaveBeenCalled();
  expect(f.execute).not.toHaveBeenCalled();
  expect(JSON.stringify(f.ledger.current())).toBe(before);
}

test.each(["mutation", "mixed"] as const)("a nested %s handoff cannot inherit its current observation descriptor", async (effect) => {
  const f = await nestedFixture();
  await nestedHandoff(f, "nested.outer", "dependency.operation", effect);
  await expectNestedContinuationRejected(f, "nested.outer");
  await settleNestedOperation(f, "dependency.operation");
  await settleNestedOperation(f, "nested.outer");
  await expectNestedContinuationRejected(f);
});

test.each(["mutation", "mixed"] as const)("a nested %s completion cannot resume its parent write", async (effect) => {
  const f = await nestedFixture();
  await nestedHandoff(f, "nested.outer", "dependency.operation");
  await settleNestedOperation(f, "dependency.operation");
  await settleNestedOperation(f, "nested.outer", effect);
  await expectNestedContinuationRejected(f);
});

test.each(["mutation", "mixed"] as const)("a descendant's recorded %s survives every completed observation ancestor", async (effect) => {
  const f = await nestedFixture();
  await nestedHandoff(f, "nested.outer", "nested.inner");
  await nestedHandoff(f, "nested.inner", "dependency.operation");
  await settleNestedOperation(f, "dependency.operation", effect);
  await expectNestedContinuationRejected(f, "nested.inner");
  await settleNestedOperation(f, "nested.inner");
  await expectNestedContinuationRejected(f, "nested.outer");
  await settleNestedOperation(f, "nested.outer");
  await expectNestedContinuationRejected(f);
});

test.each(["mutation", "mixed"] as const)("a resumed nested author cannot hide a %s in its repeated handoff", async (effect) => {
  const f = await nestedFixture();
  await nestedHandoff(f, "nested.outer", "dependency.operation");
  await settleNestedOperation(f, "dependency.operation");
  await nestedHandoff(f, "nested.outer", "dependency.second", effect);
  await expectNestedContinuationRejected(f, "nested.outer");
  await settleNestedOperation(f, "dependency.second");
  await settleNestedOperation(f, "nested.outer");
  await expectNestedContinuationRejected(f);
});

test("nested observations still resume the original accepted mutation", async () => {
  const f = await nestedFixture();
  await nestedHandoff(f, "nested.outer", "nested.inner");
  await nestedHandoff(f, "nested.inner", "dependency.operation");
  await settleNestedOperation(f, "dependency.operation");
  await settleNestedOperation(f, "nested.inner");
  await settleNestedOperation(f, "nested.outer");
  expect(projectNestedContinuation(f)).toMatchObject({ phase: "write", observationToolsOnly: true });
  expect(await resumeFilePayloadAuthoring(f.request, {
    head: f.ledger.current(), call: f.call(), steeringSnapshot: f.steering.snapshot(),
  })).toMatchObject({ decision: { action: "invoke_capability", capabilityId: "document.write",
    controls: { path: "report.txt" } } });
  expect(f.ledger.current().state.capabilityExecutions[0]).toMatchObject({ declaredEffect: "mutation" });
  expect(f.invoke).not.toHaveBeenCalled();
});

test("saved parent approval rejects an incompatible nested completion before adapter restoration", async () => {
  const f = await nestedFixture();
  await nestedHandoff(f, "nested.outer", "dependency.operation");
  await settleNestedOperation(f, "dependency.operation");
  await settleNestedOperation(f, "nested.outer", "mutation");
  await f.begin("document.write", "report.txt");
  await expect(runRequestRunner(f.request, { durableApproval: true, continuation: f.checkpoint() }))
    .rejects.toThrow("execution_file_handoff_approval_incompatible");
  expect(f.restore).not.toHaveBeenCalled();
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.invoke).not.toHaveBeenCalled();
});
