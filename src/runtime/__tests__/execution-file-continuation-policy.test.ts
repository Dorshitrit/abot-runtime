import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { projectFilePayloadContinuation } from "../request/execution-file-payload/continuation.js";
import { resumeFilePayloadAuthoring } from "../request/execution-file-payload/resume.js";
import { EXECUTION_AGENT_ROOT_CONTRACT } from "../request/execution-agent-root-execution.js";
import { projectRequestToolResults } from "../context/request-tool-results.js";
import { fileContinuationFixture } from "./support/execution-file-continuation-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

describe("RAW observation-only continuation provenance", () => {
  test.each(["mutation", "mixed"] as const)("legacy %s handoff is rejected before the auxiliary tool", async (effect) => {
    const f = await fileContinuationFixture(effect);
    await f.handoff();
    const before = JSON.stringify(f.ledger.current());
    await expect(resumeFilePayloadAuthoring(f.request, {
      head: f.ledger.current(), call: f.call(), steeringSnapshot: f.steering.snapshot(),
    })).rejects.toThrow("execution_file_handoff_incompatible");
    expect(JSON.stringify(f.ledger.current())).toBe(before);
    expect(f.invoke).not.toHaveBeenCalled();
  });

  test("a settled legacy mutation preserves its evidence and never automatically replays the write", async () => {
    const f = await fileContinuationFixture("mutation");
    await f.handoff();
    await f.settle(await f.begin());
    const before = JSON.stringify(f.ledger.current());
    await expect(resumeFilePayloadAuthoring(f.request, {
      head: f.ledger.current(), call: f.call(), steeringSnapshot: f.steering.snapshot(),
    })).rejects.toThrow("execution_file_handoff_incompatible");
    expect(JSON.stringify(f.ledger.current())).toBe(before);
    expect(f.ledger.current().state.capabilityExecutions.at(-1)).toMatchObject({ outcome: "succeeded", declaredEffect: "mutation" });
  });

  test.each([false, true])("the root stops an incompatible handoff before any new EA choice; auxiliary settled=%s", async (settled) => {
    const f = await fileContinuationFixture("mutation");
    await f.handoff();
    if (settled) await f.settle(await f.begin());
    const head = f.ledger.current();
    const before = JSON.stringify(head);
    await expect(EXECUTION_AGENT_ROOT_CONTRACT.decide(f.request, {
      head, callFrame: f.call(), call: EXECUTION_AGENT_ROOT_CONTRACT.projectCallIdentity(head),
      toolResults: projectRequestToolResults({ ledger: f.ledger, head, callId: f.call().callId, modelStep: "execution.decision" }),
      includeAcknowledgement: false, includeTitle: false, allowedRoleIds: [], availableWorkerCapabilityCatalog: [],
    })).rejects.toThrow("execution_file_handoff_incompatible");
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.restore).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(JSON.stringify(f.ledger.current())).toBe(before);
  });

  test("a settled observation resumes the exact original write", async () => {
    const f = await fileContinuationFixture();
    await f.handoff();
    await f.settle(await f.begin());
    expect(await resumeFilePayloadAuthoring(f.request, {
      head: f.ledger.current(), call: f.call(), steeringSnapshot: f.steering.snapshot(),
    })).toMatchObject({ decision: { action: "invoke_capability", capabilityId: "document.write",
      controls: { path: "report.txt" }, authoringObjective: "Write the accepted report." } });
    expect(f.invoke).not.toHaveBeenCalled();
  });

  test("changing a descriptor to observation cannot erase an already recorded mutation", async () => {
    const f = await fileContinuationFixture("mutation");
    await f.handoff();
    await f.settle(await f.begin());
    const capabilities = f.capabilities.map((entry) => ({ ...entry, effect: "observation" as const }));
    expect(projectFilePayloadContinuation({ executions: f.ledger.current().state.capabilityExecutions,
      call: f.call(), capabilities, steeringVersion: 0 })).toMatchObject({ observationToolsOnly: false });
  });

  test("unrelated newer operations retire the old incompatible lineage", async () => {
    const f = await fileContinuationFixture("mutation");
    await f.handoff();
    await f.settle(await f.begin("dependency.second"));
    expect(projectFilePayloadContinuation({ executions: f.ledger.current().state.capabilityExecutions,
      call: f.call(), capabilities: f.capabilities, steeringVersion: 0 })).toBeUndefined();
  });

  test("an unknown auxiliary descriptor and a changed steering version do not resume", async () => {
    const f = await fileContinuationFixture();
    await f.handoff(["unknown.capability"]);
    const params = { executions: f.ledger.current().state.capabilityExecutions, call: f.call(), capabilities: f.capabilities };
    expect(projectFilePayloadContinuation({ ...params, steeringVersion: 0 })).toMatchObject({ observationToolsOnly: false });
    expect(projectFilePayloadContinuation({ ...params, steeringVersion: 1 })).toBeUndefined();
  });
});
