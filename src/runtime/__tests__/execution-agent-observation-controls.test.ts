import { afterEach, beforeEach, expect, test } from "vitest";
import type { CapabilityDescriptor } from "../orchestration/capability-adapters/index.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createExecutionAgentDecisionFormat, parseExecutionAgentDecisionOutput } from "../steps/execution-agent/index.js";
import { refineExecutionCapabilityInvocations } from "../steps/execution-agent/refinement.js";
import { createWorkerDecisionFormat } from "../steps/worker-decision/format.js";
import { parseWorkerDecisionOutput } from "../steps/worker-decision/parser.js";
import {
  createObservationControlsFixture, observationCapsule, observationDescriptor, observationDecision,
  observationRefinementCall, observedRange,
} from "./support/execution-observation-controls-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

function propertySchemas(value: unknown, property: string): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap((entry) => propertySchemas(entry, property));
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const properties = record.properties as Record<string, unknown> | undefined;
  const direct = properties?.[property];
  return [
    ...(direct && typeof direct === "object" ? [direct as Record<string, unknown>] : []),
    ...Object.values(record).flatMap((entry) => propertySchemas(entry, property)),
  ];
}

const parse = (decision: unknown, descriptor = observationDescriptor) =>
  parseExecutionAgentDecisionOutput(JSON.stringify({ decision }), {
    capabilities: [descriptor], maxBatchCapabilityExecutions: 4,
  });

test("EA exposes complete observation controls while the same frozen SUPER descriptor retains its split", () => {
  const original = JSON.stringify(observationDescriptor);
  const options = { capabilities: [observationDescriptor], maxBatchCapabilityExecutions: 4 };
  const ea = createExecutionAgentDecisionFormat(options);
  const worker = createWorkerDecisionFormat(options);
  for (const schema of propertySchemas(ea.schema, "selectionControls")) {
    expect(Object.keys(schema.properties as object).sort()).toEqual(["end_line", "locator", "path", "start_line"]);
    expect(schema.required).toEqual(["path", "start_line", "end_line", "locator"]);
  }
  expect(propertySchemas(ea.schema, "selectionControls").length).toBeGreaterThan(0);
  expect(propertySchemas(ea.schema, "controlsEvidenceExecutionIds")).toEqual([]);
  expect(propertySchemas(ea.schema, "operationObjective")).toEqual([]);
  for (const schema of propertySchemas(worker.schema, "selectionControls")) {
    expect(Object.keys(schema.properties as object)).toEqual(["path"]);
  }
  const pending = { capabilityId: observationDescriptor.capabilityId, intent: "Inspect the next window.",
    selectionControls: { path: "project/styles.css" } };
  const refined = createWorkerDecisionFormat({ ...options, pendingCapabilitySelection: pending });
  expect(propertySchemas(refined.schema, "controls")).toEqual([expect.objectContaining({
    properties: expect.objectContaining({ start_line: expect.any(Object), end_line: expect.any(Object) }),
  })]);
  const workerParsed = parseWorkerDecisionOutput(JSON.stringify({ decision: {
    action: "invoke_capability", controls: { start_line: 241, end_line: 480 },
  } }), undefined, { availableCapabilities: [observationDescriptor], decisionPhase: "capability_execution",
    pendingCapabilitySelection: pending, maxBatchCapabilityExecutions: 4 });
  expect(workerParsed).toMatchObject({ ok: true, decision: {
    controls: { path: "project/styles.css", start_line: 241, end_line: 480 },
  } });
  expect(JSON.stringify(observationDescriptor)).toBe(original);
  expect(observationDescriptor.selectionControlIds).toEqual(["path"]);
});

test("EA materializes an explicit range and deliberately omits null optional controls", () => {
  expect(parse(observationDecision(observedRange(241, 480)))).toMatchObject({ ok: true, decision: {
    controls: { path: "project/styles.css", start_line: 241, end_line: 480 },
    selectionControls: { path: "project/styles.css", start_line: 241, end_line: 480 },
  } });
  const result = parse(observationDecision({ path: "project/styles.css", start_line: null, end_line: null, locator: null }));
  expect(result).toMatchObject({ ok: true, decision: {
    selectionControls: { path: "project/styles.css" }, controls: { path: "project/styles.css" },
  } });
  if (!result.ok || result.decision.action !== "invoke_capability") throw new Error("expected_observation");
  expect(result.decision.controls).not.toHaveProperty("start_line");
  expect(result.decision.controls).not.toHaveProperty("locator");
  expect(result.decision).not.toHaveProperty("controlsEvidenceExecutionIds");
});

test.each([
  { path: null, start_line: 241 },
  { path: "project/styles.css", start_line: 0 },
  { path: "project/styles.css", end_line: 10001 },
  { path: "project/styles.css", start_line: 1.5 },
  { path: "project/styles.css", locator: "" },
  { path: "project/styles.css", unknown: true },
])("invalid observation controls are rejected before refinement: %j", (controls) => {
  expect(parse(observationDecision(controls))).toMatchObject({ ok: false });
});

test.each([
  { effect: "mutation" as const },
  { effect: "mixed" as const },
  { effect: "observation" as const, requiresPayloadAuthoringObjective: true as const },
])("nonordinary observation contracts retain their controls/evidence stage: %j", (override) => {
  const descriptor: CapabilityDescriptor = { ...observationDescriptor, ...override };
  const format = createExecutionAgentDecisionFormat({ capabilities: [descriptor] });
  expect(propertySchemas(format.schema, "selectionControls")).toEqual([expect.objectContaining({
    properties: { path: expect.any(Object) },
  })]);
  expect(propertySchemas(format.schema, "controlsEvidenceExecutionIds")).toHaveLength(1);
  expect(propertySchemas(format.schema, "operationObjective")).toHaveLength(1);
  const decision = { ...observationDecision({ path: "project/styles.css" }),
    operationObjective: "Complete the selected operation.", controlsEvidenceExecutionIds: [] };
  expect(parse(decision, descriptor)).toMatchObject({ ok: true });
  expect(parse({ ...decision, selectionControls: observedRange(241, 480) }, descriptor)).toMatchObject({ ok: false });
});

test.each(["mutation", "mixed"] as const)("an observation batch still rejects effect=%s", (effect) => {
  const nonObservation: CapabilityDescriptor = { ...observationDescriptor, capabilityId: "source.change", effect };
  const result = parseExecutionAgentDecisionOutput(JSON.stringify({ decision: {
    action: "invoke_capabilities", invocations: [
      { capabilityId: observationDescriptor.capabilityId, selectionControls: observedRange(241, 480) },
      { capabilityId: nonObservation.capabilityId, selectionControls: { path: "project/styles.css" },
        operationObjective: "Change the selected source.", controlsEvidenceExecutionIds: [] },
    ],
  } }), { capabilities: [observationDescriptor, nonObservation], maxBatchCapabilityExecutions: 4 });
  expect(result).toMatchObject({ ok: false });
});

test.each([{ start_line: 1 }, { path: "other.css" }, { locator: "reset" }])(
  "ordinary observation has no second control author even if its reply would replace arguments: %j", async (refinementControls) => {
    const fixture = createObservationControlsFixture({ guidance: "Use the selected source window.", refinementControls });
    const parsed = parse(observationDecision(observedRange(241, 480)));
    if (!parsed.ok || parsed.decision.action !== "invoke_capability") throw new Error("expected_observation");
    await expect(refineExecutionCapabilityInvocations(fixture.request, {
      ...await observationRefinementCall(), capabilities: [observationDescriptor], eligibleSessionArtifactPaths: [],
      steeringSnapshot: fixture.steering.snapshot(), invocations: [parsed.decision],
    })).resolves.toMatchObject({ disposition: "execute", invocations: [{
      controls: { path: "project/styles.css", start_line: 241, end_line: 480 },
    }] });
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.invoke).not.toHaveBeenCalled();
  },
);

test("an ordinary observation and payload observation keep independent control ownership in one batch", async () => {
  const payloadDescriptor: CapabilityDescriptor = { ...observationDescriptor, capabilityId: "source.extract_payload",
    requiresPayloadAuthoringObjective: true };
  const fixture = createObservationControlsFixture({ additionalDescriptors: [payloadDescriptor],
    guidance: "Ordinary observations choose their own complete window.",
    guidanceByCapability: { [payloadDescriptor.capabilityId]: "Materialize the selected payload operation." },
    refinementControls: { start_line: 481, end_line: 720 } });
  const parsed = parseExecutionAgentDecisionOutput(JSON.stringify({ decision: {
    action: "invoke_capabilities", invocations: [
      { capabilityId: observationDescriptor.capabilityId,
        selectionControls: observedRange(241, 480) },
      { capabilityId: payloadDescriptor.capabilityId,
        operationObjective: "Extract the following source window into the requested payload.",
        controlsEvidenceExecutionIds: [], selectionControls: { path: "project/styles.css" } },
    ],
  } }), { capabilities: [observationDescriptor, payloadDescriptor], maxBatchCapabilityExecutions: 4 });
  if (!parsed.ok || parsed.decision.action !== "invoke_capabilities") throw new Error("expected_observation_batch");
  const result = await refineExecutionCapabilityInvocations(fixture.request, {
    ...await observationRefinementCall(), capabilities: [observationDescriptor, payloadDescriptor],
    eligibleSessionArtifactPaths: [], steeringSnapshot: fixture.steering.snapshot(), invocations: parsed.decision.invocations,
  });
  expect(result.invocations).toMatchObject([
    { capabilityId: observationDescriptor.capabilityId,
      controls: { path: "project/styles.css", start_line: 241, end_line: 480 } },
    { capabilityId: payloadDescriptor.capabilityId,
      controls: { path: "project/styles.css", start_line: 481, end_line: 720 },
      authoringObjective: "Extract the following source window into the requested payload." },
  ]);
  expect(fixture.calls).toHaveLength(1);
  expect(fixture.calls[0]!.step).toBe("capability.controls");
  const assignment = observationCapsule(fixture.calls[0]!.messages, "runtime_execution_capability_refinement_v1");
  expect(assignment?.invocations).toEqual([expect.objectContaining({
    slot: "invocation_2", capabilityId: payloadDescriptor.capabilityId,
  })]);
});
