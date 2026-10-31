import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { assessRequestMessagesBudget } from "../context/request-context-budget.js";
import { defaultSupervisorPresentation, supervisorFormatName } from "./support/supervisor-model-phases.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import {
  createKnowledgeSkillsRequestFixture,
  decision,
  capsules,
  exactSkillOutput,
  KNOWLEDGE_FIXTURE_DOCUMENTS,
  messages,
  type KnowledgeModelInput,
} from "./support/knowledge-skills-request-fixture.js";

type Fixture = Awaited<ReturnType<typeof createKnowledgeSkillsRequestFixture>>;
const fixtures: Fixture[] = [];
const [skill] = KNOWLEDGE_FIXTURE_DOCUMENTS;

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

async function fixture(policy: "execution-agent-v1" | "supervisor-worker-v1") {
  const f = await createKnowledgeSkillsRequestFixture(policy);
  fixtures.push(f);
  f.config.models = {
    ...f.config.models,
    profiles: {
      "scheduled-model": { ...f.config.models!.profiles!["scheduled-model"]!, contextWindowTokens: 32000 },
    },
  };
  f.application.services.models.countInputTokens = vi.fn(async () => ({
    inputTokens: 9001, profileId: "scheduled-model", provider: "ollama", model: "scripted",
    contextWindowTokens: 32000, source: "provider_input_token_count" as const,
  }));
  return f;
}

function assertCatalog(input: KnowledgeModelInput) {
  const content = messages(input)[0]!.content;
  if (supervisorFormatName(input) === "supervisor_skill_selection") {
    const catalog = JSON.parse(content.split("\n").find((line) => line.startsWith('{"kind":"runtime_supervisor_skill_candidates_v1"'))!);
    expect(catalog.skills).toContainEqual({ skillId: skill.skillId, name: skill.name, description: skill.description });
  } else {
    expect(content).toContain("[" + skill.skillId + "]:");
  }
  expect(JSON.stringify(messages(input))).not.toContain(skill.content);
}

function assessContext(input: KnowledgeModelInput) {
  if (!input.format || typeof input.format !== "object" || !("schema" in input.format))
    throw new Error("fixture_structured_decision_schema_missing");
  return assessRequestMessagesBudget({
    messages: messages(input),
    format: { schema: input.format.schema },
    budget: { contextWindowTokens: 32000, outputReserveTokens: 1000, safetyReserveTokens: 200, attachmentReserveTokens: 100 },
  });
}

function assertAboveCompactionThreshold(input: KnowledgeModelInput) {
  const assessment = assessContext(input);
  expect(assessment.budget.estimatedInputTokens).toBeGreaterThan(assessment.budget.compactionTriggerInputTokens);
  expect(assessment.fits).toBe(true);
}

test("EA retains discovery when opening knowledge pushes context above the compaction threshold", async () => {
  const f = await fixture("execution-agent-v1");
  const prompt = "Consult the named reference. " + "Context detail. ".repeat(1800);
  await f.run(prompt, [
    { step: "execution.decision", output: input => {
      assertCatalog(input);
      const { budget } = assessContext(input);
      expect(budget.estimatedInputTokens).toBeLessThan(budget.compactionTriggerInputTokens);
      return decision({ action: "open_capability_scope", catalogGroupIds: ["knowledge"] });
    } },
    { step: "execution.decision", output: input => {
      assertAboveCompactionThreshold(input);
      assertCatalog(input);
      return decision({
        action: "invoke_capability", capabilityId: "read_skill",
        workingDirectory: ".", selectionControls: { skillId: skill.skillId },
      });
    } },
    { step: "execution.decision", output: input => {
      expect(exactSkillOutput(input, "read_skill").content).toBe(skill.content);
      return decision({ action: "respond" });
    } },
    { step: "execution.response", output: "Reference consulted." },
  ], "Reference consulted.");
  expect(f.application.services.models.countInputTokens).toHaveBeenCalled();
  expect(f.store.read).toHaveBeenCalledExactlyOnceWith(skill.skillId);
  expect(f.implementation.mock.calls.map(([params]) => params)).toEqual([
    { action: "read_skill", skillId: skill.skillId },
  ]);
  for (const [input] of f.invoke.mock.calls)
    expect(messages(input).filter(({ role, content }) => role === "user" && content === prompt)).toHaveLength(1);
});

test("SUPER retains discovery above the compaction threshold and reads directly", async () => {
  const f = await fixture("supervisor-worker-v1");
  const prompt = "Consult the named reference. " + "Context detail. ".repeat(2800);
  await f.run(prompt, [
    { step: "supervisor.decision", output: input => decision(defaultSupervisorPresentation(input)) },
    { step: "supervisor.decision", output: input => {
      expect(supervisorFormatName(input)).toBe("supervisor_skill_selection");
      assertAboveCompactionThreshold(input);
      assertCatalog(input);
      return decision({ action: "read_skills", skillIds: [skill.skillId] });
    } },
    { step: "supervisor.decision", output: input => {
      expect(supervisorFormatName(input)).toBe("supervisor_procedure_gate");
      expect(capsules(input, "runtime_core_skill_read_v1").map(({ document }) => document))
        .toEqual([skill]);
      return decision({ requiresProcedure: false, responseRecommendation: "Explain the supplied reference." });
    } },
    { step: "supervisor.response", output: input => {
      const references = capsules(input, "runtime_core_skill_read_v1");
      expect(references).toContainEqual(expect.objectContaining({
        document: expect.objectContaining({ skillId: skill.skillId, content: skill.content }),
      }));
      return "Reference consulted.";
    } },
  ], "Reference consulted.");
  expect(f.application.services.models.countInputTokens).toHaveBeenCalled();
  expect(f.store.read).toHaveBeenCalledExactlyOnceWith(skill.skillId);
  expect(f.implementation).not.toHaveBeenCalled();
  expect(f.invoke.mock.calls.some(([input]) => input.modelStep?.startsWith("worker."))).toBe(false);
});
