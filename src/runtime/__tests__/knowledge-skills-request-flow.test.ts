import { workerEvidenceReply } from "./support/worker-evidence-script.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { defaultSupervisorPresentation, supervisorFormatName } from "./support/supervisor-model-phases.js";
import {
  capabilityResults,
  capsules,
  createKnowledgeSkillsRequestFixture,
  decision,
  exactSkillOutput,
  KNOWLEDGE_FIXTURE_DOCUMENTS,
  messages,
  type KnowledgeModelInput,
  type KnowledgeScriptEntry,
} from "./support/knowledge-skills-request-fixture.js";

type Fixture = Awaited<ReturnType<typeof createKnowledgeSkillsRequestFixture>>;
const fixtures: Fixture[] = [];
const [studio, computer] = KNOWLEDGE_FIXTURE_DOCUMENTS;

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

async function createFixture(policy: "execution-agent-v1" | "supervisor-worker-v1") {
  const fixture = await createKnowledgeSkillsRequestFixture(policy);
  fixtures.push(fixture);
  return fixture;
}

function assertNoStoredContent(input: KnowledgeModelInput) {
  const exposed = JSON.stringify({ messages: messages(input), format: input.format });
  for (const document of KNOWLEDGE_FIXTURE_DOCUMENTS) {
    expect(exposed).not.toContain(document.content);
  }
}

function assertAvailableSkills(input: KnowledgeModelInput) {
  assertNoStoredContent(input);
  const system = messages(input).filter(({ role }) => role === "system")
    .map(({ content }) => content).join("\n");
  for (const { skillId, name, description } of KNOWLEDGE_FIXTURE_DOCUMENTS) {
    expect(system).toContain(name + " [" + skillId + "]: " + description);
  }
}

function assertSupervisorCandidateMetadata(input: KnowledgeModelInput) {
  assertNoStoredContent(input);
  const system = messages(input).filter(({ role }) => role === "system")
    .map(({ content }) => content).join("\n");
  for (const { skillId, name, description } of KNOWLEDGE_FIXTURE_DOCUMENTS) {
    expect(system).toContain(JSON.stringify({ skillId, name, description }));
  }
}

test("EA reads directly from Available Skills through ordinary capabilities with plugins disabled", async () => {
  const fixture = await createFixture("execution-agent-v1");
  const prompt = "Read the Studio reference and explain the draft check.";
  const answer = "The reference says to verify the connected draft inputs before saving.";
  await fixture.run(prompt, [
    { step: "execution.decision", output: (input) => {
      assertAvailableSkills(input);
      expect(fixture.store.list).toHaveBeenCalled();
      expect(fixture.store.read).not.toHaveBeenCalled();
      return decision({
        action: "open_capability_scope", catalogGroupIds: ["knowledge"],
        acknowledgement: "I will read the requested reference.",
      });
    } },
    { step: "execution.decision", output: (input) => {
      assertAvailableSkills(input);
      return decision({
        action: "invoke_capability", capabilityId: "read_skill",
        intent: "Read the selected Studio document.",
        workingDirectory: ".",
        selectionControls: { skillId: studio.skillId },
      });
    } },
    { step: "execution.decision", output: (input) => {
      expect(exactSkillOutput(input, "read_skill")).toEqual({
        skillId: studio.skillId, name: studio.name, content: studio.content,
      });
      expect(capabilityResults(input).map(({ capabilityId }) => capabilityId))
        .toEqual(["read_skill"]);
      return decision({ action: "respond" });
    } },
    { step: "execution.response", output: (input) => {
      expect(exactSkillOutput(input, "read_skill").content).toBe(studio.content);
      return answer;
    } },
  ], answer);
  expect(fixture.config.plugins).toEqual({ enabled: false });
  expect(fixture.store.list).toHaveBeenCalled();
  expect(fixture.store.read).toHaveBeenCalledExactlyOnceWith(studio.skillId);
  expect(fixture.implementation.mock.calls.map(([params]) => params)).toEqual([
    { action: "read_skill", skillId: studio.skillId },
  ]);
  for (const [input] of fixture.invoke.mock.calls) {
    expect(messages(input).filter(({ role, content }) => role === "user" && content === prompt))
      .toHaveLength(1);
  }
});

test("SUPER supplies captured Skills to Planner and Worker without copying guidance into objectives", async () => {
  const fixture = await createFixture("supervisor-worker-v1");
  const objective = "Explain the two supplied reference checks.";
  const answer = studio.content + " " + computer.content;
  const checkGuidance = (input: KnowledgeModelInput) => {
    expect(capsules(input, "runtime_core_skill_read_v1").map(({ document }) => document))
      .toEqual(KNOWLEDGE_FIXTURE_DOCUMENTS);
    expect(capabilityResults(input)).toEqual([]);
  };
  await fixture.run("Consult the Studio and Computer references in two bounded tasks.", [
    { step: "supervisor.decision", output: (input) => {
      expect(supervisorFormatName(input)).toBe("supervisor_presentation");
      assertNoStoredContent(input);
      return decision(defaultSupervisorPresentation(input));
    } },
    { step: "supervisor.decision", output: (input) => {
      expect(supervisorFormatName(input)).toBe("supervisor_skill_selection");
      assertSupervisorCandidateMetadata(input);
      return decision({ action: "read_skills", skillIds: [studio.skillId, computer.skillId] });
    } },
    { step: "supervisor.decision", output: (input) => {
      expect(supervisorFormatName(input)).toBe("supervisor_procedure_gate");
      assertNoStoredContent(input);
      expect(capsules(input, "runtime_core_skill_read_v1")).toEqual([]);
      return decision({ requiresProcedure: true });
    } },
    { step: "supervisor.decision", output: (input) => {
      expect(supervisorFormatName(input)).toBe("supervisor_delegation");
      assertNoStoredContent(input);
      expect(capsules(input, "runtime_core_skill_read_v1")).toEqual([]);
      return decision({
        action: "invoke_role", roleId: "planner",
        objective: "Coordinate an explanation of the two supplied reference checks.",
      });
    } },
    { step: "supervisor.decision", output: JSON.stringify({ workingDirectory: "." }) },
    { step: "planner.decision", output: (input) => {
      checkGuidance(input);
      const assignment = capsules(input, "runtime_planner_assignment")[0]!;
      for (const { content } of KNOWLEDGE_FIXTURE_DOCUMENTS) {
        expect(assignment.objective).not.toContain(content);
      }
      return decision({
        action: "invoke_role", roleId: "worker",
        workerCapabilityScope: { catalogGroupIds: ["knowledge"] },
        plan: { summary: "Explain the supplied checks.", items: [
          { title: "Explain reference checks", objective },
        ] },
        selectedItemIndexes: [0],
      });
    } },
    { step: "worker.evidence", output: (input) => {
      checkGuidance(input);
      expect(capsules(input, "runtime_worker_assignment")[0]?.objective).toBe(objective);
      return workerEvidenceReply(input, false).text;
    } },
    { step: "worker.result", output: (input) => {
      checkGuidance(input);
      return answer;
    } },
    { step: "planner.decision", output: (input) => {
      checkGuidance(input);
      expect(capsules(input, "runtime_child_result")).toEqual(expect.arrayContaining([
        expect.objectContaining({
          callerCallId: "call-2", childCallId: "call-3", summary: answer,
        }),
      ]));
      return decision({ action: "return_result", result: answer });
    } },
    { step: "supervisor.decision", output: (input) => {
      expect(supervisorFormatName(input)).toBe("supervisor_decision");
      checkGuidance(input);
      expect(capsules(input, "runtime_child_result")).toEqual(expect.arrayContaining([
        expect.objectContaining({ childCallId: "call-2", summary: answer }),
      ]));
      return decision({ action: "respond" });
    } },
    { step: "supervisor.response", output: (input) => {
      checkGuidance(input);
      return answer;
    } },
  ], answer);
  expect(fixture.store.list).toHaveBeenCalled();
  expect(fixture.store.read.mock.calls).toEqual([[studio.skillId], [computer.skillId]]);
  expect(fixture.implementation).not.toHaveBeenCalled();
});

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
  "%s exposes metadata but answers an unrelated request without reading a document",
  async (policy) => {
    const fixture = await createFixture(policy);
    const rootStep = policy === "execution-agent-v1" ? "execution" : "supervisor";
    const preparation: KnowledgeScriptEntry[] = policy === "execution-agent-v1" ? [] : [
      { step: "supervisor.decision", output: (input) => {
        expect(supervisorFormatName(input)).toBe("supervisor_presentation");
        return decision(defaultSupervisorPresentation(input, "Hello."));
      } },
      { step: "supervisor.decision", output: (input) => {
        expect(supervisorFormatName(input)).toBe("supervisor_skill_selection");
        assertSupervisorCandidateMetadata(input);
        return decision({ action: "continue" });
      } },
    ];
    await fixture.run("Say hello.", [
      ...preparation,
      { step: rootStep + ".decision" as "execution.decision" | "supervisor.decision", output: (input) => {
        if (policy === "execution-agent-v1") assertAvailableSkills(input);
        else {
          expect(supervisorFormatName(input)).toBe("supervisor_procedure_gate");
          assertNoStoredContent(input);
        }
        return decision(policy === "execution-agent-v1"
          ? { action: "respond", acknowledgement: "Hello." }
          : { requiresProcedure: false, responseRecommendation: "Greet the user briefly." });
      } },
      { step: rootStep + ".response" as "execution.response" | "supervisor.response", output: (input) => {
        assertNoStoredContent(input);
        return "Hello.";
      } },
    ], "Hello.");
    expect(fixture.store.list).toHaveBeenCalled();
    expect(fixture.store.read).not.toHaveBeenCalled();
    expect(fixture.implementation).not.toHaveBeenCalled();
  },
);
