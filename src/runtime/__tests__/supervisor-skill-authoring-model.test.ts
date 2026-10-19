import { afterEach, beforeEach, expect, test } from "vitest";
import { projectOllamaFormat, toOpenAIResponsesTextFormat } from "../../model-gateway/structured-output.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createRequestExecutionScope } from "../request/execution-scope.js";
import { projectSupervisorCallIdentity } from "../steps/supervisor-decision/ledger-projection.js";
import { runSupervisorDecision } from "../steps/supervisor-decision/run.js";
import { createSupervisorDecisionFormat } from "../steps/supervisor-decision/format.js";
import { parseSupervisorDecisionOutput } from "../steps/supervisor-decision/parser.js";
import { createSupervisorSkillAuthoringFormat, parseSupervisorSkillAuthoringOutput } from "../steps/supervisor-skill-authoring/contract.js";
import { canOfferSupervisorSkillAuthoring } from "../steps/supervisor-skill-authoring/input.js";
import { activeCoreSkillCall, commitSkillFixture, CORE_SKILL_DOCUMENT, createCoreSkillContextFixture } from "./support/core-skill-read-context-fixture.js";
import { supervisorFormatName } from "./support/supervisor-model-phases.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());
const availableSkillWriteOperationIds = ["create_skill", "update_skill"];
const options = { writeOperationIds: availableSkillWriteOperationIds, personalSkills: [CORE_SKILL_DOCUMENT] };
const output = (decision: unknown) => JSON.stringify({ decision });

test("metadata selection preserves requested edits and rejects body, revision and read controls", () => {
  const selected = { action: "update_skill", skillId: CORE_SKILL_DOCUMENT.skillId, name: "New name", description: "New applicability" };
  expect(parseSupervisorSkillAuthoringOutput(output(selected), options)).toEqual({ ok: true, decision: selected });
  expect(parseSupervisorSkillAuthoringOutput(output({ action: "update_skill", skillId: CORE_SKILL_DOCUMENT.skillId }), options))
    .toEqual({ ok: true, decision: { action: "update_skill", skillId: CORE_SKILL_DOCUMENT.skillId } });
  for (const extra of [{ content: "body" }, { expectedRevision: 1 }, { authoringObjective: "copy this" }]) {
    expect(parseSupervisorSkillAuthoringOutput(output({ ...selected, ...extra }), options).ok).toBe(false);
  }
  expect(parseSupervisorSkillAuthoringOutput(output({ action: "read_edit_target", skillId: CORE_SKILL_DOCUMENT.skillId }), options).ok).toBe(false);
  expect(parseSupervisorSkillAuthoringOutput(output({ ...selected, skillId: "system-skill" }), options).ok).toBe(false);
});

test("metadata contract offers only available writes and bounded no-save reasons", () => {
  expect(parseSupervisorSkillAuthoringOutput(output({ action: "create_skill", name: "A", description: "When needed" }), options).ok).toBe(true);
  expect(parseSupervisorSkillAuthoringOutput(output({ action: "create_skill", name: "A", description: "When needed" }), {
    ...options, writeOperationIds: [],
  }).ok).toBe(false);
  expect(parseSupervisorSkillAuthoringOutput(output({ action: "no_save", reason: "x".repeat(300) }), options).ok).toBe(true);
  expect(parseSupervisorSkillAuthoringOutput(output({ action: "no_save", reason: "x".repeat(301) }), options).ok).toBe(false);
  expect(parseSupervisorSkillAuthoringOutput(output({ action: "no_save", reason: "  " }), options).ok).toBe(false);
  const format = createSupervisorSkillAuthoringFormat(options);
  expect(() => projectOllamaFormat(format)).not.toThrow();
  expect(() => toOpenAIResponsesTextFormat(format)).not.toThrow();
});

test("routing adds only the gated author_skill action and keeps memory schema constraints valid", () => {
  expect(parseSupervisorDecisionOutput(output({ action: "author_skill" })).ok).toBe(false);
  expect(parseSupervisorDecisionOutput(output({ action: "author_skill" }), { allowSkillAuthoring: true }))
    .toEqual({ ok: true, decision: { action: "author_skill" } });
  expect(parseSupervisorDecisionOutput(output({ action: "author_skill", name: "Extra" }), { allowSkillAuthoring: true }).ok).toBe(false);
  const format = createSupervisorDecisionFormat({ allowSkillAuthoring: true, allowMemoryRecall: true });
  expect(() => projectOllamaFormat(format)).not.toThrow();
  expect(() => toOpenAIResponsesTextFormat(format)).not.toThrow();
});

test.each([false, true])("separate selection runs only after author_skill (selected=%s)", async (author) => {
  const fixture = await createCoreSkillContextFixture();
  const formats: string[] = [];
  fixture.invoke.mockImplementation(async (input) => {
    const name = supervisorFormatName(input)!;
    formats.push(name);
    const decision = name === "supervisor_skill_selection" ? { action: "continue" }
      : name === "supervisor_skill_authoring" ? { action: "create_skill", name: "Personal", description: "Requested conventions" }
        : author ? { action: "author_skill" } : { action: "respond", responseRecommendation: "Answer the user." };
    return { text: output(decision), meta: {} };
  });
  const request = createRequestExecutionScope({
    seed: { ...fixture.request, runnerConfig: { ...fixture.request.runnerConfig,
      steps: { ...fixture.request.runnerConfig.steps, "supervisor.decision": { timeoutMs: 20_000 } } } },
    executionPolicy: fixture.request.executionPolicy,
    knowledgeSkillStore: writableStore(), createWorkerCapabilities: () => fixture.request.workerCapabilities.provider,
  });
  const result = await runSupervisorDecision(request, {
    call: projectSupervisorCallIdentity(fixture.ledger.current()), skillReadHead: fixture.ledger.current(),
    toolResults: fixture.toolResults(), availableSkillWriteOperationIds,
  });
  expect(result.decision.action).toBe(author ? "create_skill" : "respond");
  expect(formats).toEqual(["supervisor_skill_selection", "supervisor_decision", ...(author ? ["supervisor_skill_authoring"] : [])]);
  const selectionInput = fixture.invoke.mock.calls[0]![0];
  expect(JSON.stringify(selectionInput.format)).not.toContain("create_skill");
  expect(JSON.stringify(selectionInput.messages)).not.toContain("runtime_personal_skill_metadata_v1");
});

test("an unrelated failed read does not block create and authoring never invokes discovery again", async () => {
  const fixture = await createCoreSkillContextFixture();
  const call = activeCoreSkillCall(fixture.ledger);
  await commitSkillFixture(fixture.ledger, {
    authority: "runtime", type: "record_skill_read", callId: call.callId,
    invocationAttempt: call.activationCount, steeringVersion: 0,
    operation: "read_skills", selectors: ["missing"],
    result: { outcome: "failed", errorCode: "knowledge_skill_not_found", skills: [] },
  });
  const formats: string[] = [];
  fixture.invoke.mockImplementation(async (input) => {
    const name = supervisorFormatName(input)!;
    formats.push(name);
    return { text: output(name === "supervisor_decision" ? { action: "author_skill" }
      : { action: "create_skill", name: "New", description: "Explicit guidance" }), meta: {} };
  });
  const request = createRequestExecutionScope({
    seed: { ...fixture.request, runnerConfig: { ...fixture.request.runnerConfig,
      steps: { ...fixture.request.runnerConfig.steps, "supervisor.decision": { timeoutMs: 20_000 } } } },
    executionPolicy: fixture.request.executionPolicy,
    knowledgeSkillStore: writableStore(), createWorkerCapabilities: () => fixture.request.workerCapabilities.provider,
  });
  expect((await runSupervisorDecision(request, {
    call: projectSupervisorCallIdentity(fixture.ledger.current()), skillReadHead: fixture.ledger.current(),
    toolResults: fixture.toolResults(), availableSkillWriteOperationIds,
  })).decision.action).toBe("create_skill");
  expect(formats).toEqual(["supervisor_decision", "supervisor_skill_authoring"]);
});

test("authoring availability honors the cached catalog, Store mutability and capability budget", () => {
  const request = { knowledgeSkillStore: writableStore() };
  expect(canOfferSupervisorSkillAuthoring(request, { availableSkillWriteOperationIds })).toBe(true);
  expect(canOfferSupervisorSkillAuthoring(request, {})).toBe(false);
  expect(canOfferSupervisorSkillAuthoring(request, { availableSkillWriteOperationIds: [] })).toBe(false);
  expect(canOfferSupervisorSkillAuthoring(request, { availableSkillWriteOperationIds, remainingCapabilityExecutions: 0 })).toBe(false);
  expect(canOfferSupervisorSkillAuthoring({ knowledgeSkillStore: { list: () => [], read: () => undefined } }, { availableSkillWriteOperationIds })).toBe(false);
});

function writableStore() {
  return { list: () => [CORE_SKILL_DOCUMENT], read: () => CORE_SKILL_DOCUMENT,
    create: async () => { throw new Error("selection must not save"); },
    update: async () => { throw new Error("selection must not save"); } };
}
