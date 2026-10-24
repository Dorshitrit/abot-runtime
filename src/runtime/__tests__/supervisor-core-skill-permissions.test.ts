import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { createKnowledgeSkillStore } from "../knowledge-skills/store.js";
import { withSupervisorPreparation, supervisorFormatName } from "./support/supervisor-model-phases.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import {
  createSchedulerRuntimeFixture,
  scheduledModelMessages,
} from "./support/scheduler-runtime-fixture.js";

const document = {
  skillId: "private-guide", name: "Private guide", description: "Guide for this task.",
  content: "PRIVATE_GUIDANCE: Use two paragraphs.",
};
const fixtures: Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>[] = [];
beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

test.each(["abot_skills", "*"].flatMap((selector) =>
  ["list_skills", "read_skills"].map((action) => ({ selector, action })),
))("SUPER rejects an attempted $action under model deny $selector without Store access", async ({ selector, action }) => {
  const source = createKnowledgeSkillStore([document]);
  const store = { list: vi.fn(source.list), read: vi.fn(source.read) };
  const fixture = await createSchedulerRuntimeFixture("supervisor-worker-v1", undefined, undefined, store);
  fixtures.push(fixture);
  fixture.config.modelExecutionPolicies = {
    "scheduled-model": { policy: "supervisor-worker-v1", plugins: { deny: [selector] } },
  };
  fixture.invoke.mockImplementation(withSupervisorPreparation(async (input) => ({
    text: input.modelStep === "supervisor.decision"
      ? JSON.stringify({ decision: {
          action, ...(action === "read_skills" ? { skillIds: [document.skillId] } : {}),
          acknowledgement: "I will consult the reference.",
        } })
      : "Skill access is unavailable.",
    meta: {},
  })));
  await fixture.runOrdinaryRequest("Read the private guide.");
  const decisions = fixture.invoke.mock.calls.filter(([input]) => supervisorFormatName(input) === "supervisor_procedure_gate");
  expect(decisions.length).toBeGreaterThan(0);
  for (const [input] of decisions) {
    expect(JSON.stringify(input.format)).not.toContain('"list_skills"');
    expect(JSON.stringify(input.format)).not.toContain('"read_skills"');
    expect(JSON.stringify(scheduledModelMessages(input))).not.toContain(document.name);
  }
  expect(store.list).not.toHaveBeenCalled();
  expect(store.read).not.toHaveBeenCalled();
});

test("SUPER READ needs no ASK approval even without a registered Skill tool", async () => {
  const source = createKnowledgeSkillStore([document]);
  const store = { list: vi.fn(source.list), read: vi.fn(source.read) };
  const tools = createConfiguredToolRegistry(undefined, []);
  const fixture = await createSchedulerRuntimeFixture("supervisor-worker-v1", undefined, tools, store);
  fixtures.push(fixture);
  expect(tools.listNormalInvocations?.() ?? []).toEqual([]);
  let selections = 0;
  fixture.invoke.mockImplementation(withSupervisorPreparation(async (input) => ({
    text: input.modelStep === "supervisor.decision"
      ? JSON.stringify({ decision: { action: "respond" } })
      : "The guide uses two paragraphs.",
    meta: {},
  }), { selectSkills(input) {
    expect(JSON.stringify(input.format)).not.toContain('"list_skills"');
    selections += 1;
    return { action: "read_skills", skillIds: [document.skillId] };
  },
  }));
  await fixture.runOrdinaryRequest("Read the private guide.");
  expect(selections).toBe(1);
  expect(store.read).toHaveBeenCalledExactlyOnceWith(document.skillId);
  const gates = fixture.invoke.mock.calls.filter(([input]) => supervisorFormatName(input) === "supervisor_procedure_gate");
  expect(gates).toHaveLength(1);
  expect(JSON.stringify(scheduledModelMessages(gates[0]![0]))).not.toContain(document.content);
  const response = fixture.invoke.mock.calls.find(([input]) => input.modelStep === "supervisor.response")!;
  expect(JSON.stringify(scheduledModelMessages(response[0]))).toContain(document.content);
});
