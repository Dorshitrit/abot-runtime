import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildExecutionAgentInstructionParts,
  buildExecutionAgentInstructions,
  type ExecutionAgentInstructionOptions,
} from "../steps/execution-agent/prompt.js";
import { buildExecutionInputInstructions } from "../steps/execution-agent/input-instructions.js";
import { createExecutionInstructionPolicy } from "../steps/execution-agent/stable-prompt-policy.js";
import { createControlsEvidenceFixture, evidenceDescriptor } from "./support/execution-controls-evidence-fixture.js";

const unavailable: ExecutionAgentInstructionOptions = {
  hasCapabilities: false,
  hasCapabilityCatalogGroups: false,
  capabilityScopeAction: null,
  allowPlanner: false,
  availableAuditCriterionCount: 0,
  allowRespond: false,
  includeAcknowledgement: false,
  includeTitle: false,
  includeWorkingDirectory: false,
};
const offered: ExecutionAgentInstructionOptions = {
  ...unavailable,
  hasCapabilities: true,
  hasControlsEvidenceSelection: true,
  hasExecutionHistoryReference: true,
  hasCapabilityCatalogGroups: true,
  capabilityScopeAction: "extend",
  allowPlanner: true,
  allowWorkPlan: true,
  availableAuditCriterionCount: 3,
  allowRespond: true,
  allowUserInteraction: true,
  allowDirectResponse: true,
  allowMemoryRecall: true,
  hasMemoryRecallContext: true,
  includeAcknowledgement: true,
  includeTitle: true,
  includeWorkingDirectory: true,
};
const variants: ExecutionAgentInstructionOptions[] = [
  unavailable,
  offered,
  { ...offered, capabilityScopeAction: "open", availableAuditCriterionCount: 12 },
  { ...offered, capabilityScopeAction: null },
  { ...offered, allowMemoryRecall: false, hasMemoryRecallContext: true },
  { ...offered, allowDirectResponse: false },
  { ...offered, hasCapabilities: false, hasControlsEvidenceSelection: false },
  ...Object.entries(offered)
    .filter(([, value]) => typeof value === "boolean")
    .map(([field, value]) => ({ ...offered, [field]: !value })),
];

/** Remove each explicit transport allowance once; duplicates remain observable. */
function withoutTransport(text: string): string[] {
  const remaining = [...createExecutionInstructionPolicy({ ...unavailable, stableContract: true }).contractInstructions];
  const retained = text.split("\n").filter((line) => {
    const index = remaining.indexOf(line);
    if (index < 0) return true;
    remaining.splice(index, 1);
    return false;
  });
  expect(remaining).toEqual([]);
  return retained;
}

describe("Execution Agent stable instruction policy", () => {
  it("keeps only unconditional policy in an identical prefix across live availability", () => {
    const baseline = buildExecutionAgentInstructionParts({ ...unavailable, stableContract: true });
    for (const options of variants) {
      const current = buildExecutionAgentInstructionParts({ ...options, stableContract: true });
      const legacy = buildExecutionAgentInstructionParts(options);
      expect(Buffer.from(current.prefix)).toEqual(Buffer.from(baseline.prefix));
      expect(withoutTransport(current.prefix)).toEqual(legacy.prefix.split("\n"));
      expect(current.active).toBe(legacy.active);
      expect(withoutTransport(buildExecutionAgentInstructions({ ...options, stableContract: true })))
        .toEqual(buildExecutionAgentInstructions(options).split("\n"));
      // Splitting changes lanes, not membership, multiplicity or order within a lane.
      expect(withoutTransport([current.prefix, current.active].join("\n")).sort())
        .toEqual(buildExecutionAgentInstructions(options).split("\n").sort());
    }
    expect(buildExecutionAgentInstructionParts({ ...offered, stableContract: true }).active)
      .not.toBe(baseline.active);
  });

  it.each([false, true])("selects conditional and nested policy in runtime code with stable transport=%s", (stableContract) => {
    const closed = createExecutionInstructionPolicy({ ...unavailable, stableContract });
    const active = createExecutionInstructionPolicy({ ...offered, stableContract });
    expect(closed.boolean("hasCapabilities", ["available"], ["unavailable"]))
      .toEqual(["unavailable"]);
    expect(active.boolean("hasCapabilities", ["available"], ["unavailable"]))
      .toEqual(["available"]);
    const nested = createExecutionInstructionPolicy({ ...offered, hasCapabilities: false, stableContract });
    expect(nested.boolean("hasCapabilities", nested.boolean("hasExecutionHistoryReference", ["historical"], ["current"])))
      .toEqual([]);
    expect(active.boolean("hasCapabilities", active.boolean("hasExecutionHistoryReference", ["historical"], ["current"])))
      .toEqual(["historical"]);
    expect(closed.audit("offered", "unavailable")).toEqual(["unavailable"]);
    expect(active.audit("offered", "unavailable")).toEqual(["offered"]);
    for (const scope of ["open", "extend", null] as const) {
      const policy = createExecutionInstructionPolicy({ ...offered, capabilityScopeAction: scope, stableContract });
      expect(policy.scopeAction("open", "extend", "unavailable")).toEqual([scope ?? "unavailable"]);
    }
  });

  it("keeps response and recall eligibility independent of transport mode", () => {
    for (const options of variants) {
      const current = createExecutionInstructionPolicy({ ...options, stableContract: true });
      const legacy = createExecutionInstructionPolicy(options);
      expect(current.respond()).toEqual(legacy.respond());
      expect(current.memoryRecall()).toEqual(legacy.memoryRecall());
    }
  });

  it("assembles selected policy and contextual guidance once in the trusted suffix", async () => {
    const fixture = await createControlsEvidenceFixture();
    for (const options of variants) {
      const params = {
        request: fixture.request, options,
        capabilities: options.hasCapabilities ? [evidenceDescriptor] : [], observationGuidance: [],
        directResponseMaxLength: options.allowDirectResponse ? 128 : undefined,
        directMemoryAuthoring: false, remainingExecutions: options.hasCapabilities ? 4 : 0,
      };
      const legacy = buildExecutionInputInstructions({ ...params, stablePrefix: false });
      const current = buildExecutionInputInstructions({ ...params, stablePrefix: true });
      const parts = buildExecutionAgentInstructionParts({ ...options, stableContract: true });
      const legacyCore = buildExecutionAgentInstructions(options);
      expect(legacy.instructions.startsWith(legacyCore)).toBe(true);
      expect(current.instructions).toBe(parts.prefix);
      expect(current.referenceMessages).toEqual([
        { role: "system", content: parts.active + legacy.instructions.slice(legacyCore.length) },
      ]);
      expect(withoutTransport([current.instructions, ...current.referenceMessages.map(({ content }) => content)].join("\n")).sort())
        .toEqual(legacy.instructions.split("\n").sort());
    }
    expect(fixture.invoke).not.toHaveBeenCalled();
    expect(fixture.countInputTokens).not.toHaveBeenCalled();
  });

  it("preserves the legacy input bytes when contextual guidance is empty", async () => {
    const fixture = await createControlsEvidenceFixture();
    const projected = buildExecutionInputInstructions({
      request: fixture.request, options: unavailable, capabilities: [], observationGuidance: [],
      directMemoryAuthoring: false, remainingExecutions: 0, stablePrefix: false,
    });
    expect(projected.instructions).toBe(buildExecutionAgentInstructions(unavailable));
    expect(projected.referenceMessages).toEqual([]);
  });

  it.each([
    [unavailable, "e674855fe915cb06cb57a78c7704007d10ec78482dc9d6a7608240da746deb4b"],
    [offered, "ae5b49b005e7bb0d4af4ff6851caa6b88687ca97d9d6cc5c0bd76e760479ab00"],
  ] as const)("preserves the pre-change legacy policy bytes when stability is not selected", (options, expected) => {
    for (const stableContract of [undefined, false]) {
      const text = buildExecutionAgentInstructions({ ...options, stableContract });
      expect(createHash("sha256").update(text).digest("hex")).toBe(expected);
      expect(text).not.toContain("runtime_execution_decision_contract_v1");
    }
  });
});
