import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { createKnowledgeSkillsToolModule } from "../capabilities/knowledge-skills/tool-module.js";
import { createKnowledgeSkillStore } from "../knowledge-skills/store.js";
import { projectAvailableTools } from "../capabilities/tool-availability.js";
import { projectAvailableSkills } from "../knowledge-skills/available-skills.js";
import { recomposeRuntimeEnvironment } from "../runtime-environment.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createSchedulerRuntimeFixture, scheduledModelMessages } from "./support/scheduler-runtime-fixture.js";

const custom = { skillId: "custom-guide", name: "Custom guide", description: "Private custom guide.", content: "CUSTOM_BODY" };
beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { resetDebugLoggerConfig(); vi.restoreAllMocks(); });

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
  "%s does not invent a Store for an injected registry; LIST and READ still work",
  async (policy) => {
    const store = createKnowledgeSkillStore([custom]);
    const tools = createConfiguredToolRegistry(undefined, [createKnowledgeSkillsToolModule(store)]);
    const fixture = await createSchedulerRuntimeFixture(policy, undefined, tools);
    try {
      expect(fixture.application.services.knowledgeSkillStore).toBeUndefined();
      await fixture.runOrdinaryRequest("Hello.");
      const allMessages = fixture.invoke.mock.calls.flatMap(([input]) => scheduledModelMessages(input));
      const text = allMessages.map(({ content }) => content).join("\\n");
      expect(text).not.toContain("[computer-use]:");
      expect(text).not.toContain("[abot-studio]:");
      expect(text).not.toContain("[custom-guide]:");
      const list = await tools.execute({ tool: "abot_skills", params: { action: "list_skills" } });
      expect(JSON.parse(list.output).skills).toEqual([{
        skillId: custom.skillId, name: custom.name, description: custom.description,
      }]);
      const read = await tools.execute({ tool: "abot_skills", params: { action: "read_skill", skillId: custom.skillId } });
      expect(JSON.parse(read.output).content).toBe(custom.content);
    } finally { await fixture.dispose(); }
  },
);

test("recomposition preserves a known registry/Store pair but never inherits it for a replacement registry", async () => {
  const fixture = await createSchedulerRuntimeFixture();
  const services = [];
  try {
    const bound = fixture.application.services;
    const same = recomposeRuntimeEnvironment(fixture.config, bound, { tools: bound.tools });
    services.push(same);
    expect(same.knowledgeSkillStore).toBe(bound.knowledgeSkillStore);
    const customStore = createKnowledgeSkillStore([custom]);
    const tools = createConfiguredToolRegistry(undefined, [createKnowledgeSkillsToolModule(customStore)]);
    const unknown = recomposeRuntimeEnvironment(fixture.config, bound, { tools });
    services.push(unknown);
    expect(unknown.knowledgeSkillStore).toBeUndefined();
    expect(projectAvailableSkills(unknown.knowledgeSkillStore, projectAvailableTools(tools.listNormalInvocations!()))).toEqual([]);
    const explicit = recomposeRuntimeEnvironment(fixture.config, bound, { tools, knowledgeSkillStore: customStore });
    services.push(explicit);
    expect(explicit.knowledgeSkillStore).toBe(customStore);
    const rebuilt = recomposeRuntimeEnvironment(fixture.config, explicit, {});
    services.push(rebuilt);
    expect(rebuilt.knowledgeSkillStore).toBe(customStore);
    const read = await rebuilt.tools.execute({
      tool: "abot_skills", params: { action: "read_skill", skillId: custom.skillId },
    });
    expect(JSON.parse(read.output).content).toBe(custom.content);
  } finally {
    for (const service of services) await service.stopScheduler?.();
    await fixture.dispose();
  }
});
