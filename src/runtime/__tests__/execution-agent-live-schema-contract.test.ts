import { describe, expect, test } from "vitest";
import { validateJsonSchemaValue } from "../model/json-schema-value.js";
import type { ExecutionAgentDecisionContractOptions } from "../steps/execution-agent/contracts.js";
import { projectStableExecutionDecisionFormat } from "../steps/execution-agent/stable-decision-format.js";
import { parseStableExecutionAgentDecisionOutput } from "../steps/execution-agent/stable-decision-wire.js";
import { stableReadCapability, stableWriteCapability } from "./support/stable-decision-fixture.js";

const liveContract: ExecutionAgentDecisionContractOptions = {
  capabilities: [stableReadCapability, stableWriteCapability],
  capabilityCatalogGroupIds: ["read", "write"],
  activeCapabilityCatalogGroupIds: ["read", "write"],
  maxBatchCapabilityExecutions: 2,
  eligibleControlsEvidenceExecutionIds: ["execution-one"],
  allowUserInteraction: true,
  allowPlanner: true,
};
const readSelection = { capabilityId: "read_file", selectionControls: { path: "one.txt" } };
const read = { action: "invoke_capability", ...readSelection, interaction: null };
const write = {
  action: "invoke_capability", capabilityId: "write_file",
  selectionControls: { path: "result.txt" }, operationObjective: "Write the requested result.",
  controlsEvidenceExecutionIds: ["execution-one"], interaction: null,
};
const batch = {
  action: "invoke_capabilities", interaction: null,
  invocations: [readSelection, { ...readSelection, selectionControls: { path: "two.txt" } }],
};

function formatFor(contract: ExecutionAgentDecisionContractOptions) {
  return projectStableExecutionDecisionFormat(contract, contract.capabilities ?? []);
}

function expectAccepted(decision: object, contract = liveContract) {
  const format = formatFor(contract);
  expect(validateJsonSchemaValue(format.schema, { decision })).toBeUndefined();
  expect(parseStableExecutionAgentDecisionOutput(JSON.stringify({ decision }), contract, format))
    .toMatchObject({ ok: true });
}

function expectRejectedBySchema(decision: object, contract = liveContract) {
  expect(validateJsonSchemaValue(formatFor(contract).schema, { decision })).toBeDefined();
}

describe("EA provider schema follows the live semantic offer", () => {
  test.each([
    { name: "read", decision: read },
    { name: "write", decision: write },
    { name: "observation batch", decision: batch },
  ])("does not expose forbidden presentation fields on a valid $name", ({ decision }) => {
    expectAccepted(decision);
    for (const field of ["title", "acknowledgement"]) {
      expectRejectedBySchema({ ...decision, [field]: "Unrequested progress text" });
      expectRejectedBySchema({ ...decision, [field]: null });
    }
  });

  test("requires non-null presentation values when the first activation offers them", () => {
    const contract = { ...liveContract, includeAcknowledgement: true, includeTitle: true };
    const decision = { ...read, acknowledgement: "I will read the requested input.", title: "Read requested input" };
    expectAccepted(decision, contract);
    for (const field of ["title", "acknowledgement"] as const) {
      expectRejectedBySchema({ ...decision, [field]: null }, contract);
      const missing: Record<string, unknown> = { ...decision };
      delete missing[field];
      expectRejectedBySchema(missing, contract);
    }
  });

  test("offers a working-directory selection only before the base becomes immutable", () => {
    expectRejectedBySchema({ ...read, workingDirectory: "another-project" });
    expectRejectedBySchema({ ...read, workingDirectory: null });
    const contract = { ...liveContract, includeWorkingDirectory: true };
    expectAccepted({ ...read, workingDirectory: null }, contract);
    expectAccepted({ ...read, workingDirectory: "project" }, contract);
    expectRejectedBySchema(read, contract);
  });

  test("does not infer an available work plan from Planner support", () => {
    const workPlan = { mode: "adopt", sourceResultRef: "plan-one", itemUpdates: [] };
    expectRejectedBySchema({ ...read, workPlan });
    expectRejectedBySchema({ ...read, workPlan: null });
    const contract = { ...liveContract, workPlan: { sources: [{ sourceResultRef: "plan-one", itemIds: ["item-one"] }] } };
    expectAccepted({ ...read, workPlan }, contract);
    expectAccepted({ ...read, workPlan: null }, contract);
  });

  test("separates response-authoring, direct-response and memory-authoring offers", () => {
    expectAccepted({ action: "respond" });
    expectRejectedBySchema({ action: "respond", response: "Complete answer" });
    const direct = { ...liveContract, directResponseMaxLength: 32 };
    expectAccepted({ action: "respond", response: "Complete answer" }, direct);
    expectAccepted({ action: "respond" }, direct);
    expectRejectedBySchema({ action: "respond", response: null }, direct);
    expectRejectedBySchema({ action: "respond", response: "Complete answer", memoryCandidates: [] }, direct);
    const authoring = { ...direct, directResponseMemoryAuthoring: {} };
    expectAccepted({ action: "respond", response: "Complete answer", memoryCandidates: [] }, authoring);
    expectAccepted({ action: "respond" }, authoring);
    expectRejectedBySchema({ action: "respond", response: null, memoryCandidates: [] }, authoring);
    expectRejectedBySchema({ action: "respond", response: "Complete answer", memoryCandidates: null }, authoring);
  });

  test("offers recall only while recall remains available", () => {
    const decision = { action: "recall_memory", query: "Earlier user preference", interaction: null };
    expectRejectedBySchema(decision);
    expectAccepted(decision, { ...liveContract, allowMemoryRecall: true });
  });

  test("offers audit only when the live contract has an audit", () => {
    const decision = { action: "invoke_auditor", criterionIds: ["request_completion"], interaction: null };
    expectRejectedBySchema(decision);
    expectRejectedBySchema(decision, { ...liveContract, allowAuditor: true, availableAuditCriterionIds: [] });
    expectAccepted(decision, { ...liveContract, allowAuditor: true, availableAuditCriterionIds: ["request_completion"] });
  });

  test("keeps existing Planner and interaction eligibility aligned", () => {
    const decision = { action: "invoke_planner", objective: "Plan the requested change.", interaction: null };
    expectAccepted(decision);
    expectRejectedBySchema(decision, { ...liveContract, allowPlanner: false });
    const withoutInteraction = { ...liveContract, allowUserInteraction: false };
    expectRejectedBySchema(read, withoutInteraction);
    expectAccepted({ action: "invoke_capability", ...readSelection }, withoutInteraction);
  });

  test("retains deliberate numeric and evidence supersets with exact runtime rejection", () => {
    const restricted = { ...liveContract, maxBatchCapabilityExecutions: 1, eligibleControlsEvidenceExecutionIds: [] };
    const format = formatFor(restricted);
    expect(format).toEqual(formatFor(liveContract));
    for (const decision of [batch, write]) {
      expect(validateJsonSchemaValue(format.schema, { decision })).toBeUndefined();
      expect(parseStableExecutionAgentDecisionOutput(JSON.stringify({ decision }), restricted, format))
        .toMatchObject({ ok: false });
    }
  });
});
