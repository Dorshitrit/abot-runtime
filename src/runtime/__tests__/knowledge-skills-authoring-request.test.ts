import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";
import { decision, exactSkillOutput, messages, type KnowledgeModelInput } from "./support/knowledge-skills-request-fixture.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createRuntimeKnowledgeSkillStore } from "../knowledge-skills/personal-store.js";
import { defaultSupervisorPresentation, supervisorFormatName } from "./support/supervisor-model-phases.js";

type Fixture = Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>;
type Step = { step: string; output: string | ((input: KnowledgeModelInput) => string) };
const fixtures: Fixture[] = [];
const input = { name: "My Git review", description: "For reviewing Git changes." };
const initialBody = "# My review\n\nRead the diff before making changes.";
const editedBody = initialBody + "\nReport test results briefly.";
const answer = "The personal Skill was created and edited.";
beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

test.each(["execution-agent-v1"] as const)(
  "%s authors through existing RAW, reads a revision and edits the persisted personal Skill", async (policy) => {
    const f = await createSchedulerRuntimeFixture(policy);
    fixtures.push(f);
    let createdId = "";
    let rawCalls = 0;
    const executorStep = policy === "execution-agent-v1" ? "execution.decision" : "worker.decision";
    const call = (capabilityId: string, selectionControls: Record<string, unknown>, objective?: string) =>
      decision({ action: "invoke_capability", capabilityId, selectionControls, intent: "Save the requested personal guidance.",
        ...(objective ? (policy === "execution-agent-v1" ? { operationObjective: objective } : { authoringObjective: objective }) : {}),
        ...(policy === "execution-agent-v1" && capabilityId === "create_skill" ? { workingDirectory: "." } : {}),
        ...(policy === "execution-agent-v1" && capabilityId === "update_skill" ? { controlsEvidenceExecutionIds: [] } : {}) });
    const createObjective = "Create the user's Git review Skill with the supplied convention.";
    const updateObjective = "Add the requested brief test reporting convention, preserving existing content.";
    const checkSaved = (input: KnowledgeModelInput, capabilityId: string, revision: number) => {
      const receipt = exactSkillOutput(input, capabilityId);
      expect(receipt).toMatchObject({ name: "My Git review", source: "personal", revision });
      expect(receipt).not.toHaveProperty("content");
      return receipt.skillId as string;
    };
    const common: Step[] = [
      { step: executorStep, output: call("create_skill", input, createObjective) },
      { step: executorStep, output: (modelInput) => {
        createdId = checkSaved(modelInput, "create_skill", 1);
        return call("read_skill", { skillId: createdId });
      } },
      { step: executorStep, output: (modelInput) => {
        expect(exactSkillOutput(modelInput, "read_skill")).toMatchObject({
          ...input, skillId: createdId, source: "personal", revision: 1, content: initialBody,
        });
        return call("update_skill", { skillId: createdId, expectedRevision: 1 }, updateObjective);
      } },
      { step: executorStep, output: (modelInput) => {
        expect(checkSaved(modelInput, "update_skill", 2)).toBe(createdId);
        return decision({ action: policy === "execution-agent-v1" ? "respond" : "return_result" });
      } },
    ];
    const script: Step[] = [
      { step: executorStep, output: decision({ action: "open_capability_scope",
        catalogGroupIds: ["knowledge"], acknowledgement: "I will save your Skill." }) },
      ...common,
      { step: "execution.response", output: answer },
    ];
    let next = 0;
    let controlsCalls = 0;
    let assertion: unknown;
    const author = (modelInput: KnowledgeModelInput) => {
      expect(modelInput.modelStep).toBe("tool_payload.raw");
      const prefix = "Canonical runtime context:\n";
      const context = messages(modelInput).find(({ content }) => content.startsWith(prefix));
      expect(context).toBeDefined();
      const canonical = JSON.parse(context!.content.slice(prefix.length));
      const editing = rawCalls++ === 1;
      expect(canonical.acceptedCapability).toMatchObject({
        capabilityId: editing ? "update_skill" : "create_skill",
        authoringObjective: editing ? updateObjective : createObjective,
        controls: editing ? { skillId: createdId, expectedRevision: 1 } : input,
      });
      if (editing) expect(JSON.stringify(messages(modelInput))).toContain("Read the diff before making changes.");
      return { text: editing ? editedBody : initialBody, meta: {} };
    };
    f.invoke.mockImplementation(async (modelInput) => {
      try {
        if (modelInput.modelStep === "tool_payload.raw") return author(modelInput);
        if (modelInput.modelStep === "capability.controls") {
          controlsCalls++;
          return { text: policy === "execution-agent-v1"
            ? decision({ invocations: { invocation_1: { disposition: "execute", controls: {} } } })
            : decision({ action: "invoke_capability", controls: {} }), meta: {} };
        }
        const current = script[next++];
        expect(current, "unexpected_step:" + modelInput.modelStep).toBeDefined();
        expect(modelInput.modelStep).toBe(current!.step);
        return { text: typeof current!.output === "string" ? current!.output : current!.output(modelInput), meta: {} };
      } catch (error) { assertion ??= error; throw error; }
    });
    const events: Record<string, unknown>[] = [];
    await f.application.requests.handle({ send(value: string) { events.push(JSON.parse(value)); } } as unknown as WebSocket, {
      type: "run_request", requestId: "authoring-request", sessionId: "session",
      text: "Create a Git review Skill: read the diff before changes. Then add brief test reporting.",
      agentMode: "reasoning", modelPreference: { profileId: "scheduled-model", scope: "all" }, toolPermissionMode: "full_access",
    });
    if (assertion) throw assertion;
    expect(next, JSON.stringify(events.at(-1))).toBe(script.length);
    expect(rawCalls).toBe(2);
    expect(controlsCalls).toBe(1);
    expect(f.invokeRaw).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ type: "completed", output: answer }));
    const reloaded = createRuntimeKnowledgeSkillStore(f.config.paths.runtimeDir);
    expect(reloaded.read(createdId)).toMatchObject({ ...input, content: editedBody, revision: 2 });
    const completed = events.filter(({ name, tool }) => name === "tool.completed" && tool === "abot_skills");
    expect(completed).toHaveLength(3);
    expect(completed.map(({ meta }) => meta)).toEqual([
      expect.objectContaining({ skillAction: "create_skill", skillTitle: input.name, savedSkillId: createdId }),
      expect.objectContaining({ skillAction: "read_skill", skillId: createdId, skillTitle: input.name }),
      expect.objectContaining({ skillAction: "update_skill", skillId: createdId, skillTitle: input.name }),
    ]);
    expect(JSON.stringify(completed)).not.toContain("Read the diff before making changes.");
    // A later request sees persisted metadata through the same default composition, without a body read.
    f.invoke.mockClear();
    f.invoke.mockImplementation(async (modelInput) => {
      if (modelInput.modelStep === "execution.response" || modelInput.modelStep === "supervisor.response")
        return { text: "Hello.", meta: {} };
      const phase = supervisorFormatName(modelInput);
      if (phase === "supervisor_presentation")
        return { text: decision(defaultSupervisorPresentation(modelInput)), meta: {} };
      if (phase === "supervisor_decision") return { text: decision({ action: "respond" }), meta: {} };
      const system = messages(modelInput).filter(({ role }) => role === "system").map(({ content }) => content).join("\n");
      expect(system).toContain(createdId);
      expect(system).toContain(input.name);
      expect(system).not.toContain(editedBody);
      return { text: decision({ action: phase === "supervisor_skill_selection" ? "continue" : "respond" }), meta: {} };
    });
    await f.runOrdinaryRequest("Hello.", "metadata-refresh");
    expect(f.invoke).toHaveBeenCalled();
  },
);
