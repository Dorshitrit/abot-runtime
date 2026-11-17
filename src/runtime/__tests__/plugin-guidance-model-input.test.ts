import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { RegisteredToolNormalInvocation } from "../../capabilities/tool-types.js";
import { createRegisteredToolWorkerCapabilityProvider } from "../adapters/registered-tool-worker-capabilities.js";
import { resolveKnowledgeSkillReadTargets } from "../capabilities/knowledge-skills/read-targets.js";
import { createSkillsContextProvider } from "../context/skills-context.js";
import { buildAvailableSkillsText } from "../knowledge-skills/available-skills-projection.js";
import { builtinKnowledgeSkillStore } from "../knowledge-skills/catalog.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { ToolRegistry } from "../ports.js";
import { buildExecutionObservationGuidanceInstructions } from "../steps/execution-agent/observation-guidance.js";
import { buildExecutionControlsRefinementInstructions } from "../steps/execution-agent/refinement-prompt.js";
import { projectWorkerCapabilityExecutionGuidance } from "../steps/worker-decision/input/execution-guidance.js";

const sourceIds = ["internal_lookup_skill", "internal_mutation_skill", "internal_unrelated_skill"];
const lookupBody = [
  "# Lookup instructions",
  "",
  "Preserve the selected source and exact range.  Keep these two spaces.",
  "Use returned evidence; a missing match does not prove absence.",
  "```json",
  '{"mode":"bounded","label":"skill is ordinary document content"}',
  "```",
].join("\n");
const mutationBody = "# Change instructions\n\nApply only the frozen change. Verify the returned receipt before reporting success.";
const unrelatedBody = "# Unrelated instructions\n\nThis belongs only to an unrelated operation.";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

function registration(
  toolName: string,
  operationIds: readonly string[],
  effect: "read_only" | "mutating" = "read_only",
): RegisteredToolNormalInvocation {
  return {
    toolName,
    definition: {
      name: toolName,
      routingCapability: "filesystem_inspection",
      executionEffect: effect,
      params: {},
    },
    contract: {
      version: 1,
      operations: operationIds.map((operationId) => ({
        operationId,
        summary: `Perform ${operationId}.`,
        effect,
        approval: "request_policy",
        input: { type: "object", properties: {}, required: [], additionalProperties: false },
      })),
    },
  };
}

function fixture() {
  const source = createSkillsContextProvider({
    skills: {
      [sourceIds[0]!]: lookupBody,
      [sourceIds[1]!]: mutationBody,
      [sourceIds[2]!]: unrelatedBody,
    },
    actionSkills: {
      fixture_lookup: [sourceIds[0]!],
      fixture_mutation: [sourceIds[1]!],
      fixture_unrelated: [sourceIds[2]!],
    },
  });
  const registrations = [
    registration("fixture_lookup", ["inspect_one", "inspect_many"]),
    registration("fixture_mutation", ["apply_change"], "mutating"),
    registration("fixture_unrelated", ["unrelated_operation"]),
  ];
  const definitions = registrations.map(({ definition }) => definition);
  const execute = vi.fn<ToolRegistry["execute"]>();
  const registry: ToolRegistry = {
    listDefinitions: () => definitions,
    listNormalInvocations: () => registrations,
    getDefinition: (name) => definitions.find((definition) => definition.name === name),
    hasToolsAvailable: () => true,
    getImplementations: () => ({}),
    execute,
  };
  const loadActionSkillContext = vi.fn((toolName: string) => source.getActionContext(toolName));
  const provider = createRegisteredToolWorkerCapabilityProvider({
    getRequestToolRegistry: () => registry,
    requestId: "request-plugin-guidance",
    sessionId: "session-plugin-guidance",
    abortSignal: new AbortController().signal,
    toolPermissionMode: "full_access",
    nextApprovalId: () => "approval-unused",
    loadActionSkillContext,
  });
  const guidance = (capabilityId: string) => provider.getExecutionGuidance!(capabilityId);
  return { provider, guidance, execute, loadActionSkillContext };
}

function expectPrivateIdsAbsent(text: string) {
  for (const sourceId of sourceIds) expect(text).not.toContain(sourceId);
}

test("Worker receives the complete mapped instructions without a plugin document ID", async () => {
  const { provider, guidance, execute, loadActionSkillContext } = fixture();
  const descriptors = provider.getDescriptors();
  const before = structuredClone(descriptors);
  const selected = {
    capabilityId: "inspect_one",
    intent: "Inspect the selected source.",
    selectionControls: {},
    guidance: await guidance("inspect_one"),
  };
  const projected = projectWorkerCapabilityExecutionGuidance({ selectedCapabilityExecution: selected }).join("\n");

  expect(projected).toContain(lookupBody);
  expectPrivateIdsAbsent(projected);
  expect(projected).not.toContain(mutationBody);
  expect(projected).not.toContain(unrelatedBody);
  expect(loadActionSkillContext).toHaveBeenCalledExactlyOnceWith("fixture_lookup");
  expect(provider.getDescriptors()).toEqual(before);
  expect(descriptors.map(({ capabilityId }) => capabilityId)).toEqual([
    "inspect_one", "inspect_many", "apply_change", "unrelated_operation",
  ]);
  await expect(guidance(sourceIds[0]!)).rejects.toThrow("guidance_capability_unavailable");
  expect(execute).not.toHaveBeenCalled();
});

test("Worker batch keeps shared instructions bound to both selected operation IDs", async () => {
  const { guidance } = fixture();
  const invocations = await Promise.all(["inspect_one", "inspect_many"].map(async (capabilityId) => ({
    capabilityId,
    intent: "Inspect the selected source.",
    guidance: await guidance(capabilityId),
  })));
  const before = structuredClone(invocations);
  const lines = projectWorkerCapabilityExecutionGuidance({ selectedCapabilityBatchExecution: { invocations } });
  const text = lines.join("\n");
  const binding = lines.find((line) => line.includes("invocation_1 (inspect_one)"));

  expect(text.split(lookupBody)).toHaveLength(2);
  expect(binding).toContain("invocation_2 (inspect_many)");
  expect(text).not.toContain("unrelated_operation");
  expect(text).not.toContain(unrelatedBody);
  expectPrivateIdsAbsent(text);
  expect(invocations).toEqual(before);
});

test("EA observation projection keeps only guidance for its offered observation capabilities", async () => {
  const { provider, guidance } = fixture();
  const offered = provider.getDescriptors().filter(({ capabilityId }) =>
    capabilityId === "inspect_one" || capabilityId === "apply_change");
  const before = structuredClone(offered);
  const entries = await Promise.all(["inspect_one", "apply_change", "unrelated_operation"].map(async (capabilityId) => ({
    capabilityId,
    guidance: await guidance(capabilityId),
  })));
  const text = buildExecutionObservationGuidanceInstructions(offered, entries).join("\n");

  expect(text).toContain("inspect_one");
  expect(text).toContain(lookupBody);
  expect(text).not.toContain("apply_change");
  expect(text).not.toContain(mutationBody);
  expect(text).not.toContain("unrelated_operation");
  expect(text).not.toContain(unrelatedBody);
  expectPrivateIdsAbsent(text);
  expect(offered).toEqual(before);
});

test("EA refinement preserves complete instructions and the frozen invocation identity", async () => {
  const { guidance } = fixture();
  const pending = [{ slot: "invocation_3", capabilityId: "apply_change", guidance: await guidance("apply_change") }];
  const before = structuredClone(pending);
  const text = buildExecutionControlsRefinementInstructions(pending);

  expect(text).toContain("invocation_3 apply_change");
  expect(text).toContain(mutationBody);
  expect(text).not.toContain(lookupBody);
  expect(text).not.toContain(unrelatedBody);
  expectPrivateIdsAbsent(text);
  expect(pending).toEqual(before);
});

test("Knowledge Skill discovery and exact reads retain their separate public IDs", async () => {
  const { guidance } = fixture();
  const pluginText = await guidance("inspect_one");
  const skills = builtinKnowledgeSkillStore.list();
  const discovery = buildAvailableSkillsText({ skills, budgetTokens: 4096 })!;
  const input = [discovery, pluginText].join("\n");

  for (const skill of skills) {
    expect(input).toContain(`[${encodeURIComponent(skill.skillId)}]:`);
    expect(resolveKnowledgeSkillReadTargets(builtinKnowledgeSkillStore, [skill.skillId])).toMatchObject({
      ok: true,
      skills: [{ skillId: skill.skillId }],
    });
  }
  expectPrivateIdsAbsent(input);
  expect(resolveKnowledgeSkillReadTargets(builtinKnowledgeSkillStore, [sourceIds[0]!])).toEqual({
    ok: false, errorCode: "knowledge_skill_not_found",
  });
});
