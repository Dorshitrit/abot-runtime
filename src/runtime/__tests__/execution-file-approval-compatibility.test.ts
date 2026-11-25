import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { runRequestRunner } from "../request/runner.js";
import { assertFilePayloadApprovalCompatible } from "../request/execution-file-payload/approval-compatibility.js";
import { resumeFilePayloadAuthoring } from "../request/execution-file-payload/resume.js";
import { fileContinuationFixture } from "./support/execution-file-continuation-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

describe("saved RAW handoff approval compatibility", () => {
  test.each(["mutation", "mixed"] as const)("a parked legacy %s auxiliary cannot bypass RAW policy on cold restore", async (effect) => {
    const f = await fileContinuationFixture(effect);
    await f.handoff();
    await f.begin();
    const continuation = f.checkpoint();
    const before = JSON.stringify(continuation);
    await expect(runRequestRunner(f.request, { durableApproval: true, continuation }))
      .rejects.toThrow("execution_file_handoff_approval_incompatible");
    expect(f.restore).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.invoke).not.toHaveBeenCalled();
    expect(JSON.stringify(continuation)).toBe(before);
  });

  test.each(["removed", "no longer a payload source"] as const)("a parked legacy mutation remains blocked when its original writer is %s", async (change) => {
    const f = await fileContinuationFixture("mutation");
    await f.handoff();
    await f.begin();
    const continuation = f.checkpoint();
    const before = JSON.stringify(continuation);
    const writerIndex = f.capabilities.findIndex(({ capabilityId }) => capabilityId === "document.write");
    if (change === "removed") f.capabilities.splice(writerIndex, 1);
    else {
      const { preparedPayloadSource: _preparedPayloadSource, ...writer } = f.capabilities[writerIndex]!;
      f.capabilities[writerIndex] = writer;
    }

    await expect(runRequestRunner(f.request, { durableApproval: true, continuation }))
      .rejects.toThrow("execution_file_handoff_approval_incompatible");
    expect(f.restore).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.invoke).not.toHaveBeenCalled();
    expect(JSON.stringify(continuation)).toBe(before);
  });

  test.each(["removed", "no longer a payload source"] as const)("a settled observation does not resume an original writer that is %s", async (change) => {
    const f = await fileContinuationFixture();
    await f.handoff();
    await f.settle(await f.begin());
    const before = JSON.stringify(f.ledger.current());
    const writerIndex = f.capabilities.findIndex(({ capabilityId }) => capabilityId === "document.write");
    if (change === "removed") f.capabilities.splice(writerIndex, 1);
    else {
      const { preparedPayloadSource: _preparedPayloadSource, ...writer } = f.capabilities[writerIndex]!;
      f.capabilities[writerIndex] = writer;
    }

    await expect(resumeFilePayloadAuthoring(f.request, {
      head: f.ledger.current(), call: f.call(), steeringSnapshot: f.steering.snapshot(),
    })).resolves.toBeUndefined();
    expect(f.restore).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.invoke).not.toHaveBeenCalled();
    expect(JSON.stringify(f.ledger.current())).toBe(before);
  });

  test("a parked parent write after a settled legacy mutation is rejected before hydration", async () => {
    const f = await fileContinuationFixture("mutation");
    await f.handoff();
    await f.settle(await f.begin());
    await f.begin("document.write", "report.txt");
    const continuation = f.checkpoint();
    const before = JSON.stringify(continuation);
    await expect(runRequestRunner(f.request, { durableApproval: true, continuation }))
      .rejects.toThrow("execution_file_handoff_approval_incompatible");
    expect(f.restore).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(JSON.stringify(continuation)).toBe(before);
  });

  test("a nested legacy mutation chain cannot hide behind a final observation dependency", async () => {
    const f = await fileContinuationFixture();
    await f.handoff(["document.write"]);
    await f.handoff(["dependency.operation"], "dependency.txt");
    await f.begin();
    await expect(runRequestRunner(f.request, { durableApproval: true, continuation: f.checkpoint() }))
      .rejects.toThrow("execution_file_handoff_approval_incompatible");
    expect(f.restore).not.toHaveBeenCalled();
  });

  test.each([false, true])("a normal EA mutation approval remains executable; old unrelated handoff=%s", async (oldHandoff) => {
    const f = await fileContinuationFixture("mutation");
    if (oldHandoff) {
      await f.handoff();
      await f.settle(await f.begin("dependency.second"));
    }
    await f.begin("document.write", "unrelated.txt");
    const result = await runRequestRunner(f.request, { durableApproval: true, continuation: f.checkpoint() });
    expect(result.kind).toBe("completed");
    expect(f.restore).toHaveBeenCalledTimes(1);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  test("an original write prepared after observation still restores without reauthoring", async () => {
    const f = await fileContinuationFixture();
    await f.handoff();
    await f.settle(await f.begin());
    await f.begin("document.write", "report.txt");
    const result = await runRequestRunner(f.request, { durableApproval: true, continuation: f.checkpoint() });
    expect(result.kind).toBe("completed");
    expect(f.restore).toHaveBeenCalledTimes(1);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.invoke.mock.calls.some(([input]) => input.modelStep === "execution.file_payload.raw")).toBe(false);
  });

  test("the compatibility guard does not apply EA policy to SUPER", async () => {
    const f = await fileContinuationFixture("mutation");
    await f.handoff();
    await f.begin();
    const head = f.ledger.current();
    expect(() => assertFilePayloadApprovalCompatible({
      head: { ...head, policy: { ...head.policy, authority: { ...head.policy.authority, rootContractId: "supervisor" } } },
      call: f.call(), group: f.checkpoint().preparedGroup, capabilities: f.capabilities,
    })).not.toThrow();
  });
});
