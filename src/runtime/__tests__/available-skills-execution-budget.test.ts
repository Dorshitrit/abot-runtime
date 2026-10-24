import { createRequestExecutionScope } from "../request/execution-scope.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildExecutionAgentInput } from "../steps/execution-agent/input.js";
import { buildSupervisorCapabilityBriefOptions } from "../steps/supervisor-decision/capability-brief.js";
import { buildSupervisorSkillSelectionInput } from "../steps/supervisor-decision/skill-selection-input.js";
import { projectAvailableTools } from "../capabilities/tool-availability.js";
import { createDefaultToolRegistry } from "../default-environment-adapters.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createControlsEvidenceFixture, activeEvidenceCall, evidenceDescriptor } from "./support/execution-controls-evidence-fixture.js";

const skills = [{ skillId: "budget-guide", name: "Budget guide", description: "Relevant guidance." }];
beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { resetDebugLoggerConfig(); vi.restoreAllMocks(); });

async function fixture() {
  const getAvailableSkills = vi.fn(() => skills);
  const workerCapabilityProvider = {
    getDescriptors: () => [evidenceDescriptor],
    getAdapters: () => [],
    getAvailableSkills,
    getAvailableTools: () => projectAvailableTools(createDefaultToolRegistry().listNormalInvocations!()),
  };
  const source = await createControlsEvidenceFixture({ workerCapabilityProvider }, 1);
  return { ...source, getAvailableSkills };
}

test("EA hides new discovery at the execution ceiling and retains settled evidence", async () => {
  const f = await fixture();
  const build = () => buildExecutionAgentInput(f.request, {
    head: f.ledger.current(), call: activeEvidenceCall(f.ledger.current()),
    steeringSnapshot: f.steering.snapshot(),
    includeAcknowledgement: false, includeTitle: false, allowPlanner: false, allowAuditor: false,
  });
  expect(JSON.stringify(build().messages)).toContain("[budget-guide]:");
  f.getAvailableSkills.mockClear();
  await f.addResult("READ_GUIDANCE_ALREADY_OBTAINED");
  const exhausted = build();
  expect(exhausted.capabilities).toEqual([]);
  expect(exhausted.contract.maxBatchCapabilityExecutions).toBe(0);
  expect(JSON.stringify(exhausted.messages)).not.toContain("[budget-guide]:");
  expect(JSON.stringify(exhausted.messages)).toContain("READ_GUIDANCE_ALREADY_OBTAINED");
  expect(f.getAvailableSkills).not.toHaveBeenCalled();
});

test("SUPER discovery depends on core read availability, not Worker or tool slots", async () => {
  const f = await fixture();
  const list = vi.fn(() => skills);
  const request = createRequestExecutionScope({
    seed: f.request, executionPolicy: f.request.executionPolicy,
    knowledgeSkillStore: { list, read: () => undefined },
    createWorkerCapabilities: () => f.request.workerCapabilities.provider,
  });
  const options = {
    allowedRoleIds: [],
    remainingRoleCalls: 0,
    remainingCapabilityExecutions: 0,
    availableWorkerCapabilityCatalog: [],
  };
  expect(buildSupervisorCapabilityBriefOptions(request, options)).not.toHaveProperty("availableSkills");
  expect(list).not.toHaveBeenCalled();
  const selection = buildSupervisorSkillSelectionInput(request);
  const catalogLine = selection.context.messages[0]!.content.split("\n")
    .find((line) => line.startsWith('{"kind":"runtime_supervisor_skill_candidates_v1"'))!;
  expect(JSON.parse(catalogLine).skills).toEqual(skills);
  expect(JSON.stringify(selection.format)).toContain('"read_skills"');
  expect(list).toHaveBeenCalledOnce();
  expect(f.getAvailableSkills).not.toHaveBeenCalled();
});
