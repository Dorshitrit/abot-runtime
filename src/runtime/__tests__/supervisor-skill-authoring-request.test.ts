import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import * as capabilityComposition from "../request/worker-capability-composition.js";
import { createRuntimeKnowledgeSkillStore } from "../knowledge-skills/personal-store.js";
import { SKILL_CREATOR } from "../knowledge-skills/builtins/skill-creator.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { SupervisorSkillAuthoringSelection } from "../steps/supervisor-skill-authoring/contract.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";
import { capsules, decision, exactSkillOutput, messages, type KnowledgeModelInput } from "./support/knowledge-skills-request-fixture.js";
import { defaultSupervisorPresentation, supervisorFormatName } from "./support/supervisor-model-phases.js";

type Fixture = Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>;
const fixtures: Fixture[] = [];
const metadata = { name: "Review conventions", description: "For code review." };
const body = "# Review conventions\n\nRead the diff before editing.\nKeep unchanged guidance.";
beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

async function runAuthoring(f: Fixture, options: {
  requestId: string;
  selection: SupervisorSkillAuthoringSelection;
  discoveryIds?: readonly string[];
  expectedDiscoveryCalls?: number;
  body?: string;
  beforeAuthoring?: () => Promise<void>;
  inspectRouting?: (input: KnowledgeModelInput) => void;
  inspectRaw?: (input: KnowledgeModelInput) => void;
  inspectResponse?: (input: KnowledgeModelInput) => void;
}) {
  const phases: string[] = [];
  let discoveryCalls = 0;
  let assertion: unknown;
  f.invoke.mockImplementation(async (input) => {
    try {
      if (input.modelStep === "tool_payload.raw") {
        phases.push("raw");
        expect(options.body).toBeDefined();
        options.inspectRaw?.(input);
        return { text: options.body!, meta: {} };
      }
      if (input.modelStep === "supervisor.response") {
        phases.push("response");
        options.inspectResponse?.(input);
        return { text: "The requested Skill operation is complete.", meta: {} };
      }
      if (input.modelStep === "worker.decision") {
        phases.push("worker.decision");
        return { text: decision({ action: "return_result" }), meta: {} };
      }
      if (input.modelStep === "worker.result") {
        phases.push("worker.result");
        return { text: "The requested personal guidance is ready for the root's authoring operation.", meta: {} };
      }
      expect(input.modelStep).toBe("supervisor.decision");
      const phase = supervisorFormatName(input);
      if (!phase) throw new Error("Missing supervisor format");
      phases.push(phase);
      if (phase === "supervisor_presentation") return { text: decision(defaultSupervisorPresentation(input)), meta: {} };
      if (phase === "supervisor_procedure_gate") return { text: decision({ requiresProcedure: true }), meta: {} };
      if (phase === "supervisor_delegation") {
        expect(JSON.stringify(input.format)).not.toContain('"author_skill"');
        return { text: decision({ action: "invoke_role", roleId: "worker", objective: "Prepare the requested personal Skill change." }), meta: {} };
      }
      if (phase === "supervisor_working_directory") return { text: JSON.stringify({ workingDirectory: "." }), meta: {} };
      if (phase === "supervisor_skill_selection") {
        expect(phases).not.toContain("supervisor_skill_authoring");
        expect(JSON.stringify(input.format)).not.toContain('"create_skill"');
        const read = discoveryCalls++ === 0 && options.discoveryIds;
        return { text: decision(read ? { action: "read_skills", skillIds: read } : { action: "continue" }), meta: {} };
      }
      if (phase === "supervisor_decision") {
        expect(phases.filter((entry) => entry === phase)).toHaveLength(1);
        expect(capsules(input, "runtime_child_result")).toContainEqual(expect.objectContaining({ roleId: "worker" }));
        options.inspectRouting?.(input);
        return { text: decision({ action: "author_skill" }), meta: {} };
      }
      expect(phase).toBe("supervisor_skill_authoring");
      expect(phases.filter((entry) => entry === phase)).toHaveLength(1);
      await options.beforeAuthoring?.();
      return { text: decision(options.selection), meta: {} };
    } catch (error) { assertion ??= error; throw error; }
  });
  const events: Record<string, unknown>[] = [];
  await f.application.requests.handle({ send(text: string) { events.push(JSON.parse(text)); } } as unknown as WebSocket, {
    type: "run_request", requestId: options.requestId, sessionId: "session",
    text: "Save the requested personal review guidance; preserve existing instructions when editing.",
    agentMode: "reasoning", modelPreference: { profileId: "scheduled-model", scope: "all" }, toolPermissionMode: "full_access",
  });
  if (assertion) throw assertion;
  expect(events.filter(({ type }) => type === "failed")).toEqual([]);
  expect(events).toContainEqual(expect.objectContaining({ type: "completed" }));
  expect(discoveryCalls).toBe(options.expectedDiscoveryCalls ?? 2);
  expect(phases.filter((phase) => ["supervisor_procedure_gate", "supervisor_delegation", "worker.decision", "worker.result", "supervisor_decision"].includes(phase)))
    .toEqual(["supervisor_procedure_gate", "supervisor_delegation", "worker.decision", "worker.result", "supervisor_decision"]);
  expect(phases.slice(phases.indexOf("supervisor_skill_authoring") + 1))
    .toEqual(options.body ? ["raw", "response"] : ["response"]);
  return { phases, events };
}

function canonicalPayload(input: KnowledgeModelInput) {
  const prefix = "Canonical runtime context:\n";
  const message = messages(input).find(({ content }) => content.startsWith(prefix));
  expect(message).toBeDefined();
  return JSON.parse(message!.content.slice(prefix.length));
}

test("SUPER creates once, reuses the routing descriptor snapshot and answers directly", async () => {
  const f = await createSchedulerRuntimeFixture("supervisor-worker-v1"); fixtures.push(f);
  const reads = vi.fn();
  const compose = capabilityComposition.createRequestWorkerCapabilityProvider;
  vi.spyOn(capabilityComposition, "createRequestWorkerCapabilityProvider").mockImplementation((params) => {
    const provider = compose(params);
    return { ...provider, getDescriptors: () => { reads(); return provider.getDescriptors(); } };
  });
  let savedId = "";
  let routingDescriptorReads = 0;
  await runAuthoring(f, {
    requestId: "create", selection: { action: "create_skill", ...metadata },
    discoveryIds: [SKILL_CREATOR.skillId], body,
    inspectRouting() { routingDescriptorReads = reads.mock.calls.length; },
    beforeAuthoring: async () => {
      expect(routingDescriptorReads).toBeGreaterThan(0);
      expect(reads).toHaveBeenCalledTimes(routingDescriptorReads);
    },
    inspectRaw(input) {
      expect(canonicalPayload(input).acceptedCapability.controls).toEqual(metadata);
      expect(capsules(input, "runtime_core_skill_read_v1")).toContainEqual(expect.objectContaining({
        document: expect.objectContaining({ skillId: SKILL_CREATOR.skillId }),
      }));
    },
    inspectResponse(input) { savedId = exactSkillOutput(input, "create_skill").skillId as string; },
  });
  expect(createRuntimeKnowledgeSkillStore(f.config.paths.runtimeDir).read(savedId))
    .toMatchObject({ ...metadata, content: body, revision: 1 });
});

test.each([false, true])("SUPER edits an exact target without a second selection; target already read=%s", async (alreadyRead) => {
  const f = await createSchedulerRuntimeFixture("supervisor-worker-v1"); fixtures.push(f);
  const store = createRuntimeKnowledgeSkillStore(f.config.paths.runtimeDir);
  const target = await store.create({ ...metadata, content: body });
  const edited = body + "\nReport material findings.";
  const updates = alreadyRead ? { name: "Team review", description: "For reviewing team changes." } : {};
  const { events } = await runAuthoring(f, {
    requestId: "update", selection: { action: "update_skill", skillId: target.skillId, ...updates },
    ...(alreadyRead ? { discoveryIds: [target.skillId] } : {}), body: edited,
    inspectRaw(input) {
      const context = canonicalPayload(input);
      expect(context.acceptedCapability.controls).toEqual({ skillId: target.skillId, expectedRevision: 1, ...updates });
      expect(context.targetContext).toMatchObject({ targetParam: "skillId", targetPath: target.skillId, presentation: "full" });
      expect(messages(input).filter(({ content }) => content.endsWith(body))).toHaveLength(1);
    },
    inspectResponse(input) { expect(exactSkillOutput(input, "update_skill")).toMatchObject({ skillId: target.skillId, revision: 2 }); },
  });
  expect(store.read(target.skillId)).toMatchObject({ ...metadata, ...updates, content: edited, revision: 2 });
  expect(events.filter((event) => JSON.stringify(event).includes("Read Skills: " + target.name))).toHaveLength(1);
});

test("a failed unrelated lookup does not disable a requested create", async () => {
  const f = await createSchedulerRuntimeFixture("supervisor-worker-v1"); fixtures.push(f);
  await runAuthoring(f, { requestId: "lookup-failed", discoveryIds: ["missing-skill"], expectedDiscoveryCalls: 3,
    selection: { action: "create_skill", ...metadata }, body });
  expect(createRuntimeKnowledgeSkillStore(f.config.paths.runtimeDir).list()).toContainEqual(expect.objectContaining(metadata));
});

test("no-save reason reaches response after a Skill read without another route or RAW call", async () => {
  const f = await createSchedulerRuntimeFixture("supervisor-worker-v1"); fixtures.push(f);
  const reason = "The requested edit target was not specified.";
  await runAuthoring(f, { requestId: "no-save", discoveryIds: [SKILL_CREATOR.skillId],
    selection: { action: "no_save", reason }, inspectResponse(input) {
      expect(capsules(input, "runtime_supervisor_response_recommendation_v1")).toContainEqual(expect.objectContaining({
        outcome: "no_save", responseRecommendation: reason,
      }));
    } });
  expect(createRuntimeKnowledgeSkillStore(f.config.paths.runtimeDir).list().filter(({ source }) => source === "personal")).toEqual([]);
});

test("a target archived after selection ends in response without RAW or retargeting", async () => {
  const f = await createSchedulerRuntimeFixture("supervisor-worker-v1"); fixtures.push(f);
  const store = createRuntimeKnowledgeSkillStore(f.config.paths.runtimeDir);
  const target = await store.create({ ...metadata, content: body });
  await runAuthoring(f, { requestId: "archived", selection: { action: "update_skill", skillId: target.skillId },
    beforeAuthoring: async () => { await store.personalSkills.archive(target.skillId, target.revision); },
    inspectResponse(input) {
      expect(capsules(input, "runtime_supervisor_response_recommendation_v1")).toContainEqual(expect.objectContaining({ outcome: "no_save" }));
    } });
  expect(store.read(target.skillId)).toBeUndefined();
});
