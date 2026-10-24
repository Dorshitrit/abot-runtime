import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { createKnowledgeSkillsToolModule } from "../capabilities/knowledge-skills/tool-module.js";
import { createKnowledgeSkillStore, KNOWLEDGE_SKILL_READ_MAX_ITEMS } from "../knowledge-skills/store.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { defaultSupervisorPresentation, supervisorFormatName } from "./support/supervisor-model-phases.js";
import {
  capsules, createKnowledgeSkillsRequestFixture, decision, exactSkillOutput,
  KNOWLEDGE_FIXTURE_DOCUMENTS, messages, type KnowledgeModelInput,
} from "./support/knowledge-skills-request-fixture.js";

const docs = KNOWLEDGE_FIXTURE_DOCUMENTS;
const skillIds = docs.map(({ skillId }) => skillId);
const expected = { skills: docs.map(({ skillId, name, content }) => ({ skillId, name, content })) };
const fixtures: Awaited<ReturnType<typeof createKnowledgeSkillsRequestFixture>>[] = [];
beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

function registry() {
  const source = createKnowledgeSkillStore(docs);
  const store = { list: vi.fn(source.list), read: vi.fn(source.read) };
  return { store, tools: createConfiguredToolRegistry(undefined, [createKnowledgeSkillsToolModule(store)]) };
}

test("multiple reads preserve order and use one result without LIST", async () => {
  const f = registry();
  const result = await f.tools.execute({ tool: "abot_skills", params: { action: "read_skills", skillIds } });
  expect(result.ok).toBe(true);
  expect(JSON.parse(result.output)).toEqual(expected);
  expect(result.data).toMatchObject({ itemCount: 2, mutationEvidence: false });
  expect(f.store.list).not.toHaveBeenCalled();
  expect(f.store.read.mock.calls).toEqual(skillIds.map((id) => [id]));
});

test.each([undefined, [], [""], [42], [" abot-studio "], ["abot-studio", "abot-studio"],
  Array.from({ length: KNOWLEDGE_SKILL_READ_MAX_ITEMS + 1 }, (_, i) => "skill-" + i),
].map((ids) => ({ ids })))("invalid multiple-read input fails before Store access: $ids", async ({ ids }) => {
  const f = registry();
  const result = await f.tools.execute({ tool: "abot_skills", params: { action: "read_skills", skillIds: ids } });
  expect(result).toMatchObject({ ok: false, errorCode: "knowledge_skill_ids_invalid" });
  expect(f.store.read).not.toHaveBeenCalled();
});

test("an unknown ID cannot produce an apparently complete partial read", async () => {
  const f = registry();
  const result = await f.tools.execute({ tool: "abot_skills", params: {
    action: "read_skills", skillIds: [skillIds[0], "missing"],
  } });
  expect(result).toMatchObject({ ok: false, errorCode: "knowledge_skill_not_found" });
  expect(result.output).not.toContain(docs[0]!.content);
});

test.each([
  { policy: "execution-agent-v1", reference: "id" },
  { policy: "execution-agent-v1", reference: "name" },
  { policy: "supervisor-worker-v1", reference: "id" },
] as const)(
  "$policy reads multiple Skills by $reference through its policy-owned read path", async ({ policy, reference }) => {
    const skillIds = docs.map((doc) => reference === "id" ? doc.skillId : doc.name);
    const f = await createKnowledgeSkillsRequestFixture(policy);
    fixtures.push(f);
    const answer = docs.map(({ content }) => content).join("\n");
    const invoke = decision({ action: "invoke_capability", capabilityId: "read_skills",
      intent: "Read both requested references.", selectionControls: { skillIds },
      ...(policy === "execution-agent-v1" ? { workingDirectory: "." } : {}) });
    const check = (input: KnowledgeModelInput) => {
      if (policy === "execution-agent-v1") {
        expect(exactSkillOutput(input, "read_skills")).toEqual(expected);
        return;
      }
      expect(capsules(input, "runtime_core_skill_read_v1").map(({ document }) => document))
        .toEqual(docs);
    };
    const readStart = (input: KnowledgeModelInput) => {
      for (const doc of docs) expect(JSON.stringify(messages(input))).not.toContain(doc.content);
      return invoke;
    };
    const script = policy === "execution-agent-v1" ? [
      { step: "execution.decision" as const, output: decision({ action: "open_capability_scope",
        catalogGroupIds: ["knowledge"], acknowledgement: "I will read both references." }) },
      { step: "execution.decision" as const, output: readStart },
      { step: "execution.decision" as const, output: (input: KnowledgeModelInput) => {
        check(input); return decision({ action: "respond" });
      } },
      { step: "execution.response" as const, output: (input: KnowledgeModelInput) => { check(input); return answer; } },
    ] : [
      { step: "supervisor.decision" as const, output: (input: KnowledgeModelInput) =>
        decision(defaultSupervisorPresentation(input)) },
      { step: "supervisor.decision" as const, output: (input: KnowledgeModelInput) => {
        expect(supervisorFormatName(input)).toBe("supervisor_skill_selection");
        for (const doc of docs) expect(JSON.stringify(messages(input))).not.toContain(doc.content);
        return decision({ action: "read_skills", skillIds });
      } },
      { step: "supervisor.decision" as const, output: (input: KnowledgeModelInput) => {
        expect(supervisorFormatName(input)).toBe("supervisor_procedure_gate");
        expect(capsules(input, "runtime_core_skill_read_v1")).toEqual([]);
        for (const doc of docs) expect(JSON.stringify(messages(input))).not.toContain(doc.content);
        return decision({ requiresProcedure: false, responseRecommendation: "Explain the two supplied references." });
      } },
      { step: "supervisor.response" as const, output: (input: KnowledgeModelInput) => {
        check(input); return answer;
      } },
    ];
    const events = await f.run("Read both references and explain them.", script, answer);
    const completed = events.filter(({ name }) => name === "tool.completed");
    if (policy === "execution-agent-v1") {
      expect(f.implementation).toHaveBeenCalledOnce();
      expect(f.implementation.mock.calls[0]![0]).toEqual({ action: "read_skills", skillIds });
      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({ ok: true, meta: { skillAction: "read_skills", skillIds,
        skillTitle: docs.map(({ name }) => name).join(", ") } });
      expect(JSON.stringify(completed[0]!.meta)).not.toContain(docs[0]!.content);
    } else {
      expect(f.implementation).not.toHaveBeenCalled();
      expect(completed).toEqual([]);
      expect(f.store.read.mock.results.map(({ value }) => value).filter(Boolean)).toEqual(docs);
    }
  },
);
