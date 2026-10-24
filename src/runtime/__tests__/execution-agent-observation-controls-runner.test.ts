import { afterEach, beforeEach, expect, test } from "vitest";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { runRequestRunner } from "../request/runner.js";
import type { CapabilityDescriptor } from "../orchestration/capability-adapters/index.js";
import {
  createObservationControlsFixture, observationApprovalFingerprint, observationCapsule, observationDescriptor, observedRange,
} from "./support/execution-observation-controls-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

test.each([false, true])("the root's next range reaches the adapter after prior evidence, compacted=%s", async (compacted) => {
  const fixture = createObservationControlsFixture({ compactFirstRead: compacted });
  await expect(runRequestRunner(fixture.request)).resolves.toMatchObject({
    output: "The requested source windows were inspected.",
  });
  expect(fixture.adapterControls).toEqual([
    { path: "project/styles.css", start_line: 1, end_line: 240 },
    { path: "project/styles.css", start_line: 241, end_line: 480 },
  ]);
  expect(fixture.calls.filter(({ step }) => step === "capability.controls")).toHaveLength(0);
  const rootInputs = fixture.calls.filter(({ step }) => step === "execution.decision");
  const nextInput = rootInputs[2]!.messages;
  if (compacted) {
    expect(fixture.calls.some(({ step }) => step === "context.compact")).toBe(true);
    expect(observationCapsule(nextInput, "runtime_semantic_compaction_checkpoint_v2")).toMatchObject({
      continuation: {
        completed: ["Inspected lines 1-240 of project/styles.css."],
        currentState: "Lines 1-240 were observed; later source lines remain unread.",
      },
      coveredSources: expect.arrayContaining([expect.objectContaining({
        digest: "Observed project/styles.css lines 1-240; the next unread line is 241.",
      })]),
    });
  }
  const freshResults = nextInput.filter((message) => message.role === "tool");
  expect(freshResults.map((message) => message.toolCallId)).toEqual(
    compacted ? [] : ["capability-execution-1"],
  );
  if (!compacted) {
    const firstResult = await fixture.execute.mock.results[0]!.value;
    expect(JSON.parse(freshResults[0]!.content)).toMatchObject({
      kind: "runtime_execution_capability_result_v1",
      invocationAttempt: 2,
      result: {
        executionId: "capability-execution-1", capabilityId: observationDescriptor.capabilityId,
        outcome: firstResult.outcome, observedEffect: firstResult.observedEffect,
        adapterResult: { payload: {
          summary: firstResult.summary, referenceData: firstResult.referenceData,
        } },
      },
    });
  }
  const finalInput = rootInputs.at(-1)!.messages;
  expect(finalInput.filter((message) => message.role === "tool")
    .map((message) => message.toolCallId)).toEqual(compacted
      ? ["capability-execution-2"] : ["capability-execution-1", "capability-execution-2"]);
  const actions = finalInput.flatMap((message) => "toolCalls" in message && message.toolCalls
    ? message.toolCalls.map(({ arguments: argumentsJson }) => JSON.parse(argumentsJson)) : []);
  expect(actions).toEqual(expect.arrayContaining([expect.objectContaining({
    invocation: expect.objectContaining({ controls: { path: "project/styles.css", start_line: 241, end_line: 480 } }),
  })]));
});

test("complete guidance reaches EA before it chooses the range, including after compaction", async () => {
  const guidance = `OBSERVATION_GUIDANCE_START\n${"Preserve the requested bounded source observation. ".repeat(40)}\nOBSERVATION_GUIDANCE_END`;
  const fixture = createObservationControlsFixture({ guidance, compactFirstRead: true });
  await runRequestRunner(fixture.request);
  expect(fixture.calls.filter(({ step }) => step === "capability.controls")).toHaveLength(0);
  const decisions = fixture.calls.filter(({ step }) => step === "execution.decision");
  expect(decisions[0]!.messages.some(({ content }) => content.includes(guidance))).toBe(false);
  for (const decision of decisions.slice(1)) {
    expect(decision.messages.some(({ role, content }) => role === "system" && content.includes(guidance))).toBe(true);
  }
  expect(fixture.countInputTokens.mock.calls.some(([input]) => input.modelStep === "execution.decision" &&
    JSON.stringify(input.messages).includes(JSON.stringify(guidance).slice(1, -1)))).toBe(true);
  expect(observationCapsule(decisions[2]!.messages, "runtime_semantic_compaction_checkpoint_v2")).toBeDefined();
  expect(fixture.adapterControls[1]).toEqual({ path: "project/styles.css", start_line: 241, end_line: 480 });
});

test("batched observations retain distinct frozen ranges without another control author", async () => {
  const fixture = createObservationControlsFixture({ guidance: "Observe exactly the selected windows.",
    batches: [[observedRange(241, 480), observedRange(481, 720)]] });
  await runRequestRunner(fixture.request);
  expect(fixture.adapterControls).toEqual([
    { path: "project/styles.css", start_line: 241, end_line: 480 },
    { path: "project/styles.css", start_line: 481, end_line: 720 },
  ]);
  expect(fixture.calls.filter(({ step }) => step === "capability.controls")).toHaveLength(0);
});

test.each([false, true])("a requester-selected literal locator reaches the adapter unchanged, compacted=%s", async (compacted) => {
  const locator = ".results-toolbar > .view-switch";
  const fixture = createObservationControlsFixture({ compactFirstRead: compacted,
    batches: [[observedRange(1, 240)], [{
      path: "project/styles.css", start_line: null, end_line: null, locator,
    }]] });
  await runRequestRunner(fixture.request);
  expect(fixture.adapterControls).toEqual([
    { path: "project/styles.css", start_line: 1, end_line: 240 },
    { path: "project/styles.css", locator },
  ]);
  expect(fixture.calls.filter(({ step }) => step === "capability.controls")).toHaveLength(0);
  expect(fixture.calls.some(({ step }) => step === "context.compact")).toBe(compacted);
});

test("deliberately omitted observation bounds reach the adapter as omissions", async () => {
  const fixture = createObservationControlsFixture({ guidance: "Read the selected target with its optional defaults.",
    batches: [[{ path: "project/styles.css", start_line: null, end_line: null, locator: null }]] });
  await runRequestRunner(fixture.request);
  expect(fixture.adapterControls).toEqual([{ path: "project/styles.css" }]);
  expect(fixture.calls.filter(({ step }) => step === "capability.controls")).toHaveLength(0);
});

test("approval resume preserves the prepared exact observation without selecting controls again", async () => {
  const fixture = createObservationControlsFixture({ approval: true,
    guidance: "Preserve the approved source range.", batches: [[observedRange(241, 480)]] });
  const waiting = await runRequestRunner(fixture.request, { durableApproval: true });
  if (waiting.kind !== "awaiting_approval") throw new Error("expected_observation_approval");
  expect(fixture.adapterControls).toEqual([]);
  expect(fixture.prepare).toHaveBeenCalledOnce();
  expect(fixture.calls.filter(({ step }) => step === "capability.controls")).toHaveLength(0);
  const persisted = JSON.parse(JSON.stringify(waiting.continuation));
  expect(JSON.stringify(persisted)).not.toContain("controlsEvidenceExecutionIds");
  const resumed = await runRequestRunner(fixture.request, { durableApproval: true, continuation: persisted,
    decisions: [{ approvalId: "observation-exact-approval", actionFingerprint: observationApprovalFingerprint,
      decision: { approved: true } }] });
  expect(resumed).toMatchObject({ kind: "completed", result: {
    output: "The requested source windows were inspected.",
  } });
  expect(fixture.adapterControls).toEqual([{ path: "project/styles.css", start_line: 241, end_line: 480 }]);
  expect(fixture.restore).toHaveBeenCalledOnce();
  expect(fixture.prepare).toHaveBeenCalledOnce();
  expect(fixture.calls.filter(({ step }) => step === "capability.controls")).toHaveLength(0);
});

test("root guidance is limited to offered ordinary observations and never loads inactive or nonordinary rules", async () => {
  const inactive: CapabilityDescriptor = { ...observationDescriptor, capabilityId: "other.observe_window", catalogGroups: ["other"] };
  const mutation: CapabilityDescriptor = { ...observationDescriptor, capabilityId: "source.change_window", effect: "mutation" };
  const mixed: CapabilityDescriptor = { ...observationDescriptor, capabilityId: "source.run_command", effect: "mixed" };
  const payload: CapabilityDescriptor = { ...observationDescriptor, capabilityId: "source.extract_payload", requiresPayloadAuthoringObjective: true };
  const fixture = createObservationControlsFixture({ guidance: "ACTIVE_OBSERVATION_GUIDANCE_ONLY",
    additionalDescriptors: [inactive, mutation, mixed, payload], batches: [[observedRange(241, 480)]],
    guidanceByCapability: { [inactive.capabilityId]: "INACTIVE_GUIDANCE_MUST_STAY_ABSENT",
      [mutation.capabilityId]: "MUTATION_GUIDANCE_MUST_STAY_ABSENT", [mixed.capabilityId]: "MIXED_GUIDANCE_MUST_STAY_ABSENT",
      [payload.capabilityId]: "PAYLOAD_GUIDANCE_MUST_STAY_ABSENT" } });
  await runRequestRunner(fixture.request);
  const decisions = fixture.calls.filter(({ step }) => step === "execution.decision");
  expect(JSON.stringify(decisions[1]!.messages)).toContain("ACTIVE_OBSERVATION_GUIDANCE_ONLY");
  expect(JSON.stringify(decisions)).not.toContain("GUIDANCE_MUST_STAY_ABSENT");
  expect(new Set(fixture.getExecutionGuidance.mock.calls.map(([capabilityId]) => capabilityId)))
    .toEqual(new Set([observationDescriptor.capabilityId]));
});
