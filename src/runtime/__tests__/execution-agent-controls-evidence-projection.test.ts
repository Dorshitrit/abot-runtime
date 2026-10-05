import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type { RoleCallLedgerHead } from "../orchestration/role-calls/index.js";
import {
  projectSelectedControlsEvidence,
  type ControlsEvidenceAssignmentSlot,
} from "../steps/execution-agent/controls-evidence.js";
import { buildExecutionAgentInput } from "../steps/execution-agent/input.js";
import { refineExecutionCapabilityInvocations } from "../steps/execution-agent/refinement.js";
import {
  activeEvidenceCall,
  controlsReply,
  createControlsEvidenceFixture,
  evidenceDescriptor,
  runtimeCapsule,
} from "./support/execution-controls-evidence-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

type Fixture = Awaited<ReturnType<typeof createControlsEvidenceFixture>>;
const slot = (
  ids: readonly string[],
  slotId = "invocation_1",
): ControlsEvidenceAssignmentSlot => ({
  slot: slotId,
  capabilityId: evidenceDescriptor.capabilityId,
  operationObjective: "Read exact evidence for this operation.",
  selectionControls: { path: "exact.txt" },
  remainingControls: {
    type: "object",
    additionalProperties: false,
    properties: { query: { type: "string", minLength: 1 } },
    required: ["query"],
  },
  controlsEvidenceExecutionIds: ids,
  guidance: "Use source data only.",
});
function project(
  fixture: Fixture,
  slots: readonly ControlsEvidenceAssignmentSlot[],
  head = fixture.ledger.current(),
) {
  return projectSelectedControlsEvidence({
    requestId: fixture.request.requestId,
    head,
    call: activeEvidenceCall(head),
    steering: fixture.steering.snapshot(),
    slots,
  });
}
async function refine(
  fixture: Fixture,
  ids: readonly string[],
  overrides: { workingDirectory?: string } = {},
) {
  const head = fixture.ledger.current();
  return refineExecutionCapabilityInvocations(fixture.request, {
    head,
    call: activeEvidenceCall(head),
    capabilities: [evidenceDescriptor],
    eligibleSessionArtifactPaths: [],
    steeringSnapshot: fixture.steering.snapshot(),
    invocations: [
      {
        capabilityId: evidenceDescriptor.capabilityId,
        intent: "Read selected evidence.",
        operationObjective: "Use the selected source exactly.",
        selectionControls: { path: "exact.txt" },
        controlsEvidenceExecutionIds: ids,
      },
    ],
    ...overrides,
  });
}

describe("EA selected Controls evidence projection", () => {
  test("C1/C2: unselected growth cannot enter Controls and [] has no result lane", async () => {
    const fixture = await createControlsEvidenceFixture();
    const selected = await fixture.addResult("selected exact content");
    const first = project(fixture, [slot([selected])]);
    for (let index = 0; index < 12; index++)
      await fixture.addResult(`UNSELECTED_${index}_` + "x".repeat(12000));
    const expanded = project(fixture, [slot([selected])]);
    expect(
      expanded.messages[0]!.content.replace(/"sourceRevision":\d+/u, ""),
    ).toBe(first.messages[0]!.content.replace(/"sourceRevision":\d+/u, ""));
    expect(JSON.stringify(expanded.messages)).not.toContain("UNSELECTED_");
    expect(project(fixture, [slot([])]).messages).toEqual([]);
    await refine(fixture, []);
    const messages = fixture.invoke.mock.calls[0]![0].messages;
    expect(
      runtimeCapsule(messages, "runtime_request_tool_results_v1"),
    ).toBeUndefined();
    expect(JSON.stringify(messages)).not.toContain("selected exact content");
  });

  test("C4/C6/C20: exact >4096 source and prior target reach Controls and field is removed", async () => {
    const fixture = await createControlsEvidenceFixture();
    const body = "exact fact and command ".repeat(300);
    const id = await fixture.addResult(body, {
      target: "/source/previous-target.txt",
    });
    fixture.invoke.mockImplementation(async (input) => {
      const serialized = JSON.stringify(input.messages);
      expect(serialized.split(body)).toHaveLength(2);
      expect(serialized).toContain("/source/previous-target.txt");
      expect(serialized).not.toContain("eligibleControlsEvidenceExecutionIds");
      return controlsReply({ query: body });
    });
    const result = await refine(fixture, [id]);
    expect(result.invocations[0]!.controls).toEqual({
      path: "exact.txt",
      query: body,
    });
    expect(result.invocations[0]).not.toHaveProperty(
      "controlsEvidenceExecutionIds",
    );
    expect(result.invocations[0]).not.toHaveProperty("operationObjective");
  });

  test("C7/C8: union preserves failed/corrected provenance and ledger order with per-slot IDs", async () => {
    const fixture = await createControlsEvidenceFixture();
    const failed = await fixture.addResult("OLD_FAILED", { failed: true });
    const fixed = await fixture.addResult("NEW_CORRECTION");
    const other = await fixture.addResult("OTHER_OPERATION");
    const projection = project(fixture, [
      slot([fixed, failed]),
      slot([other, fixed], "invocation_2"),
    ]);
    expect(
      projection.view.results.map(({ executionId, outcome }) => [
        executionId,
        outcome,
      ]),
    ).toEqual([
      [failed, "failed"],
      [fixed, "succeeded"],
      [other, "succeeded"],
    ]);
    expect(
      projection.slots.map(
        ({ controlsEvidenceExecutionIds }) => controlsEvidenceExecutionIds,
      ),
    ).toEqual([
      [failed, fixed],
      [fixed, other],
    ]);
    const content = projection.messages[0]!.content;
    for (const body of ["OLD_FAILED", "NEW_CORRECTION", "OTHER_OPERATION"])
      expect(content.split(body)).toHaveLength(2);
    expect(projection.view.results[0]!.acceptedAction).toBeDefined();
  });

  test("C9: assignment authority, guidance, schema, steering, source and head each bind scope", async () => {
    const fixture = await createControlsEvidenceFixture();
    const id = await fixture.addResult("BOUND_SOURCE");
    const original = project(fixture, [slot([id])]);
    for (const changed of [
      { ...slot([id]), operationObjective: "Different bounded objective." },
      { ...slot([id]), selectionControls: { path: "different.txt" } },
      { ...slot([id]), guidance: "Different guidance." },
      {
        ...slot([id]),
        remainingControls: { ...slot([id]).remainingControls, required: [] },
      },
      slot([]),
    ])
      expect(project(fixture, [changed]).scopeId).not.toBe(original.scopeId);
    const head = fixture.ledger.current();
    const input = {
      requestId: fixture.request.requestId,
      head,
      call: activeEvidenceCall(head),
      steering: fixture.steering.snapshot(),
      slots: [slot([id])],
    };
    const changedSourceHead = {
      ...head,
      state: {
        ...head.state,
        capabilityExecutions: head.state.capabilityExecutions.map(
          (execution) => ({
            ...execution,
            referenceData: "CHANGED_SOURCE_BYTES",
          }),
        ),
      },
    };
    expect(project(fixture, [slot([id])], changedSourceHead).scopeId).not.toBe(
      original.scopeId,
    );
    expect(
      projectSelectedControlsEvidence({
        ...input,
        workingDirectory: "/project-a",
      }).scopeId,
    ).not.toBe(
      projectSelectedControlsEvidence({
        ...input,
        workingDirectory: "/project-b",
      }).scopeId,
    );
    fixture.steering.append({
      steerId: "changed",
      text: "Use the corrected source.",
    });
    expect(project(fixture, [slot([id])]).scopeId).not.toBe(original.scopeId);
    await fixture.addResult("UNSELECTED_NEW_HEAD");
    expect(project(fixture, [slot([id])]).scopeId).not.toBe(original.scopeId);
  });

  test("C9: first selected working directory is visible before its ledger commit", async () => {
    const fixture = await createControlsEvidenceFixture();
    await refine(fixture, [], { workingDirectory: "/project-a" });
    expect(
      activeEvidenceCall(fixture.ledger.current()).workingDirectory,
    ).toBeUndefined();
    expect(
      runtimeCapsule(
        fixture.invoke.mock.calls[0]![0].messages,
        "runtime_execution_capability_refinement_v1",
      ),
    ).toMatchObject({ workingDirectory: "/project-a" });
  });

  test("C17: decision index comes from settled canonical head independently of visible history", async () => {
    const fixture = await createControlsEvidenceFixture();
    const first = await fixture.addResult("FIRST");
    const failed = await fixture.addResult("FAILED", { failed: true });
    const head = fixture.ledger.current();
    const input = buildExecutionAgentInput(fixture.request, {
      head,
      call: activeEvidenceCall(head),
      steeringSnapshot: fixture.steering.snapshot(),
      includeAcknowledgement: false,
      includeTitle: false,
      allowPlanner: true,
      allowAuditor: true,
    });
    expect(input.contract.eligibleControlsEvidenceExecutionIds).toEqual([
      first,
      failed,
    ]);
    expect(
      input.messages.filter(({ content }) =>
        content.includes('"eligibleControlsEvidenceExecutionIds":'),
      ),
    ).toHaveLength(1);
    expect(
      runtimeCapsule(input.messages, "runtime_execution_state_v1"),
    ).toMatchObject({ eligibleControlsEvidenceExecutionIds: [first, failed] });
  });

  test("C18: corrupted selected canonical evidence fails without summary fallback", async () => {
    const fixture = await createControlsEvidenceFixture();
    const id = await fixture.addResult("SELECTED");
    const head = fixture.ledger.current();
    const corrupted = {
      ...head,
      state: {
        ...head.state,
        capabilityExecutions: head.state.capabilityExecutions.map((entry) => ({
          ...entry,
          exactResult: undefined,
        })),
      },
    } as RoleCallLedgerHead;
    expect(() => project(fixture, [slot([id])], corrupted)).toThrow(
      "request_tool_results_execution_invalid",
    );
    expect(() => project(fixture, [slot(["unknown"])])).toThrow(
      "execution_controls_evidence_selection_invalid",
    );
  });
});
