import { supervisorFormatName } from "./support/supervisor-model-phases.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  projectAvailableSkills,
} from "../knowledge-skills/available-skills.js";
import { buildAvailableSkillsText } from "../knowledge-skills/available-skills-projection.js";
import { createKnowledgeSkillStore } from "../knowledge-skills/store.js";
import { createDefaultToolRegistry } from "../default-environment-adapters.js";
import { projectAvailableTools } from "../capabilities/tool-availability.js";
import { restrictToolRegistryToRequestMode } from "../capabilities/request-permission-tool-registry.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import {
  createSchedulerRuntimeFixture,
  scheduledModelMessages,
} from "./support/scheduler-runtime-fixture.js";

const document = {
  skillId: "answer-style",
  name: "Answer conventions",
  description: "Guidance for composing answers for this user.",
  content: "PRIVATE_STYLE_BODY: Use short paragraphs.",
};
const metadata = {
  skillId: document.skillId, name: document.name, description: document.description,
};

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { resetDebugLoggerConfig(); vi.restoreAllMocks(); });

test("metadata projection excludes bodies even when a Store returns extra fields", () => {
  const store = { list: vi.fn(() => [document]), read: vi.fn() };
  const registry = createDefaultToolRegistry(undefined, undefined, undefined, store);
  const result = projectAvailableSkills(store, projectAvailableTools(registry.listNormalInvocations!()));
  expect(result).toEqual([metadata]);
  expect(buildAvailableSkillsText({ skills: result, budgetTokens: 512 })).not.toContain(document.content);
  expect(store.read).not.toHaveBeenCalled();
});

test("metadata stays hidden when READ is absent, denied, or availability is unknown", () => {
  const store = { list: vi.fn(() => [document]), read: vi.fn() };
  const registry = createDefaultToolRegistry(undefined, undefined, undefined, store);
  const blocked = restrictToolRegistryToRequestMode(registry, "full_access", { deny: ["abot_skills"] });
  const listOnly = projectAvailableTools(registry.listNormalInvocations!())!
    .filter(({ operationId }) => operationId === "list_skills");
  for (const tools of [undefined, [], listOnly, projectAvailableTools(blocked.listNormalInvocations!())]) {
    expect(projectAvailableSkills(store, tools)).toEqual([]);
  }
  expect(store.list).not.toHaveBeenCalled();
  expect(store.read).not.toHaveBeenCalled();
  expect(buildAvailableSkillsText({ skills: [], budgetTokens: 512 })).toBeUndefined();
});

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
  "%s uses the same injected Store for root metadata and the default READ tool",
  async (policy) => {
    const source = createKnowledgeSkillStore([document]);
    const store = { list: vi.fn(source.list), read: vi.fn(source.read) };
    const fixture = await createSchedulerRuntimeFixture(policy, undefined, undefined, store);
    try {
      await fixture.runOrdinaryRequest("Hello.");
      const rootStep = policy === "execution-agent-v1" ? "execution.decision" : "supervisor.decision";
      const decisions = fixture.invoke.mock.calls.filter(([input]) => input.modelStep === rootStep && (policy === "execution-agent-v1" || supervisorFormatName(input) === "supervisor_skill_selection"));
      expect(decisions).toHaveLength(1);
      const system = scheduledModelMessages(decisions[0]![0])
        .filter(({ role }) => role === "system").map(({ content }) => content).join("\n");
      if (policy === "execution-agent-v1") {
        const discovery = buildAvailableSkillsText({ skills: [metadata], budgetTokens: 512 })!;
        expect(system.startsWith(discovery + "\n")).toBe(true);
        expect(system).toContain(document.name + " [" + document.skillId + "]: " + document.description);
      } else {
        const catalog = JSON.parse(system.split("\n").find((line) => line.startsWith('{"kind":"runtime_supervisor_skill_candidates_v1"'))!);
        expect(catalog.skills).toEqual([metadata]);
        expect(catalog.omittedCount).toBe(0);
      }
      expect(system).not.toContain(document.content);
      expect(store.read).not.toHaveBeenCalled();
      const result = await fixture.application.services.tools.execute({
        tool: "abot_skills", params: { action: "read_skill", skillId: document.skillId },
      });
      expect(result.ok).toBe(true);
      expect(JSON.parse(result.output)).toMatchObject({
        skillId: document.skillId, content: document.content,
      });
      expect(store.read).toHaveBeenCalledExactlyOnceWith(document.skillId);
    } finally { await fixture.dispose(); }
  },
);

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
  "%s projects no metadata when model policy denies the core tool",
  async (policy) => {
    const source = createKnowledgeSkillStore([document]);
    const store = { list: vi.fn(source.list), read: vi.fn(source.read) };
    const fixture = await createSchedulerRuntimeFixture(policy, undefined, undefined, store);
    fixture.config.modelExecutionPolicies = {
      "scheduled-model": { policy, plugins: { deny: ["abot_skills"] } },
    };
    try {
      await fixture.runOrdinaryRequest("Hello.");
      expect(fixture.invoke).toHaveBeenCalled();
      for (const [input] of fixture.invoke.mock.calls) {
        expect(JSON.stringify(scheduledModelMessages(input))).not.toContain(document.name);
        expect(JSON.stringify(scheduledModelMessages(input))).not.toContain(document.content);
        if (input.modelStep === "supervisor.decision") {
          expect(JSON.stringify(input.format)).not.toContain('"list_skills"');
          expect(JSON.stringify(input.format)).not.toContain('"read_skills"');
        }
      }
      expect(store.list).not.toHaveBeenCalled();
      expect(store.read).not.toHaveBeenCalled();
    } finally { await fixture.dispose(); }
  },
);

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
  "%s enforces its catalog budget without loading document bodies",
  async (policy) => {
    const documents = Array.from({ length: 1000 }, (_, index) => ({
      ...document, skillId: "entry-" + index,
      name: "DISPLAY_NAME".repeat(1000), description: "D".repeat(1000),
    }));
    const source = createKnowledgeSkillStore(documents);
    const store = { list: source.list, read: vi.fn(source.read) };
    const fixture = await createSchedulerRuntimeFixture(policy, undefined, undefined, store);
    try {
      await fixture.runOrdinaryRequest("Hello.");
      if (policy === "supervisor-worker-v1") {
        expect(fixture.invoke).toHaveBeenCalled();
        expect(fixture.invoke.mock.calls.some(([input]) => supervisorFormatName(input) === "supervisor_skill_selection")).toBe(false);
        expect(store.read).not.toHaveBeenCalled();
        return;
      }
      const rootStep = policy === "execution-agent-v1" ? "execution.decision" : "supervisor.decision";
      const root = fixture.invoke.mock.calls.find(([input]) => input.modelStep === rootStep)![0];
      const text = scheduledModelMessages(root).map(({ content }) => content).join("\\n");
      expect(text).toContain("[entry-0]");
      expect(text).toContain("Partial catalog");
      expect(text).not.toContain("[entry-999]");
      expect(text).toContain("DISPLAY_NAME");
      expect(text).not.toContain(documents[0]!.name);
      expect(text).not.toContain(document.content);
      expect(store.read).not.toHaveBeenCalled();
    } finally { await fixture.dispose(); }
  },
);

test("metadata remains available when only multiple-document READ is offered", () => {
  const store = createKnowledgeSkillStore([document]);
  const registry = createDefaultToolRegistry(undefined, undefined, undefined, store);
  const tools = projectAvailableTools(registry.listNormalInvocations!())!
    .filter(({ operationId }) => operationId === "read_skills");
  expect(projectAvailableSkills(store, tools)).toEqual([metadata]);
});
