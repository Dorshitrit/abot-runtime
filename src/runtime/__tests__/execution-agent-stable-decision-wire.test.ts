import { describe, expect, test } from "vitest";
import type { ExecutionAgentDecisionContractOptions } from "../steps/execution-agent/contracts.js";
import { parseExecutionAgentDecisionOutput } from "../steps/execution-agent/decision-parsing.js";
import { createStableExecutionAgentDecisionFormat } from "../steps/execution-agent/stable-decision-format.js";
import { parseStableExecutionAgentDecisionOutput } from "../steps/execution-agent/stable-decision-wire.js";
import { stableFormatOptions, stableReadCapability, stableWriteCapability } from "./support/stable-decision-fixture.js";

const optionalWorkPlan = { workPlan: null };
const liveContract: ExecutionAgentDecisionContractOptions = {
  capabilities: [stableReadCapability, stableWriteCapability], capabilityCatalogGroupIds: ["read", "write"],
  activeCapabilityCatalogGroupIds: ["read", "write"], maxBatchCapabilityExecutions: 2,
  eligibleControlsEvidenceExecutionIds: ["execution-one"], allowUserInteraction: true,
};
const read = { action: "invoke_capability", capabilityId: "read_file", selectionControls: { path: "note.txt" } };
const write = { action: "invoke_capability", capabilityId: "write_file", selectionControls: { path: "note.txt" },
  operationObjective: "Write the requested content.", controlsEvidenceExecutionIds: ["execution-one"] };

function parse(decision: object, contract: ExecutionAgentDecisionContractOptions = liveContract) {
  const format = createStableExecutionAgentDecisionFormat({ ...stableFormatOptions,
    activeCapabilityCatalogGroupIds: contract.activeCapabilityCatalogGroupIds ?? null,
  });
  return parseStableExecutionAgentDecisionOutput(JSON.stringify({ decision }), contract, format);
}

describe("stable EA wire keeps exact live acceptance", () => {
  test.each([read, write])("normalizes only declared null absence slots for $capabilityId", (decision) => {
    expect(parse({ ...decision, ...optionalWorkPlan, workingDirectory: null, interaction: null }))
      .toEqual(parseExecutionAgentDecisionOutput(JSON.stringify({ decision }), liveContract));
  });

  test("retains the meaning of null when a working-directory selection is required", () => {
    const contract = { ...liveContract, includeWorkingDirectory: true };
    const decision = { ...read, workingDirectory: null };
    expect(parse({ ...decision, ...optionalWorkPlan, interaction: null }, contract))
      .toEqual(parseExecutionAgentDecisionOutput(JSON.stringify({ decision }), contract));
    expect(parse({ ...read, ...optionalWorkPlan, workingDirectory: "another-project", interaction: null })).toMatchObject({ ok: false });
  });

  test.each(["acknowledgement", "title"] as const)("requires non-null %s exactly when live contract requests it", (field) => {
    const contract = { ...liveContract, [field === "title" ? "includeTitle" : "includeAcknowledgement"]: true };
    expect(parse({ action: "respond", ...optionalWorkPlan }, contract)).toMatchObject({ ok: false });
    expect(parse({ action: "respond", ...optionalWorkPlan, [field]: "Valid title" }, contract)).toMatchObject({ ok: true });
    expect(parse({ action: "respond", ...optionalWorkPlan, [field]: "Forbidden extra" })).toMatchObject({ ok: false });
  });

  test.each([
    { ...write, controlsEvidenceExecutionIds: ["foreign-execution"] },
    { ...write, controlsEvidenceExecutionIds: ["execution-one", "execution-one"] },
    { ...write, controlsEvidenceExecutionIds: ["execution-one", "another-execution"] },
    { ...read, capabilityId: "unoffered-capability" },
  ])("rejects unavailable or invalid live capability evidence %#", (decision) => {
    expect(parse({ ...decision, ...optionalWorkPlan, workingDirectory: null, interaction: null })).toMatchObject({ ok: false });
  });

  test("retains closed scope and exhausted budget rejection", () => {
    const decision = { ...read, ...optionalWorkPlan, workingDirectory: null, interaction: null };
    expect(parse(decision, { ...liveContract, capabilities: [], activeCapabilityCatalogGroupIds: null })).toMatchObject({ ok: false });
    expect(parse(decision, { ...liveContract, capabilities: [], maxBatchCapabilityExecutions: 0 })).toMatchObject({ ok: false });
    const invocation = { capabilityId: "read_file", selectionControls: { path: "note.txt" } };
    expect(parse({ action: "invoke_capabilities", invocations: [invocation, invocation], ...optionalWorkPlan, workingDirectory: null, interaction: null },
      { ...liveContract, maxBatchCapabilityExecutions: 1 })).toMatchObject({ ok: false });
  });

  test.each([
    { action: "open_capability_scope", active: null, selected: "read" },
    { action: "extend_capability_scope", active: ["read"], selected: "write" },
  ] as const)("accepts a valid $action at zero remaining executions as on main", ({ action, active, selected }) => {
    const decision = { action, catalogGroupIds: [selected], ...optionalWorkPlan, interaction: null };
    const contract = { ...liveContract, activeCapabilityCatalogGroupIds: active, maxBatchCapabilityExecutions: 0 };
    expect(parse(decision, contract)).toMatchObject({ ok: true });
  });

  test.each([
    { action: "recall_memory", query: "Remembered preference" },
    { action: "invoke_planner", objective: "Plan requested work" },
    { action: "invoke_auditor", criterionIds: ["criterion"] },
    { action: "open_capability_scope", catalogGroupIds: ["read"] },
    { action: "extend_capability_scope", catalogGroupIds: ["read"] },
  ])("rejects dynamically unavailable $action", (decision) => {
    expect(parse({ ...decision, ...optionalWorkPlan, interaction: null })).toMatchObject({ ok: false });
  });

  test("keeps direct response and memory-authoring gates", () => {
    const decision = { action: "respond", response: "Complete answer", ...optionalWorkPlan };
    expect(parse(decision)).toMatchObject({ ok: false });
    expect(parse(decision, { ...liveContract, directResponseMaxLength: 32 })).toMatchObject({ ok: true, decision: { response: "Complete answer" } });
    expect(parse({ ...decision, memoryCandidates: [] }, { ...liveContract, directResponseMaxLength: 32 })).toMatchObject({ ok: false });
    expect(parse({ ...decision, response: "x".repeat(33) }, { ...liveContract, directResponseMaxLength: 32 })).toMatchObject({ ok: false });
  });

  test("checks exact work-plan identities after wire normalization", () => {
    const workPlan = { mode: "adopt", sourceResultRef: "plan-current", itemUpdates: [{ itemId: "item-current", status: "pending" }] };
    const decision = { ...read, ...optionalWorkPlan, workingDirectory: null, interaction: null, workPlan };
    const contract = { ...liveContract, workPlan: { sources: [{ sourceResultRef: "plan-current", itemIds: ["item-current"] }] } };
    expect(parse(decision, contract)).toMatchObject({ ok: true });
    expect(parse({ ...decision, workPlan: { ...workPlan, sourceResultRef: "plan-stale" } }, contract)).toMatchObject({ ok: false });
    expect(parse({ ...decision, workPlan: { ...workPlan, itemUpdates: [{ itemId: "foreign-item", status: "done" }] } }, contract)).toMatchObject({ ok: false });
    expect(parse(decision)).toMatchObject({ ok: false });
  });

  test.each([null, "non-null"])("never erases unknown fields with value %s", (value) => {
    expect(parse({ action: "respond", ...optionalWorkPlan, unknown: value })).toMatchObject({ ok: false });
    expect(parse({ action: "respond", ...optionalWorkPlan, workingDirectory: value })).toMatchObject({ ok: false });
  });

  test("only recognizes null slots actually declared by the action format", () => {
    const noPlanFormat = createStableExecutionAgentDecisionFormat({ ...stableFormatOptions, allowWorkPlan: false });
    expect(parseStableExecutionAgentDecisionOutput(JSON.stringify({ decision: { action: "respond", workPlan: null } }), liveContract, noPlanFormat)).toMatchObject({ ok: false });
  });
});
