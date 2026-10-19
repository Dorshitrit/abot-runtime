import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ModelGatewayAttachment } from "../../model-gateway/types.js";
import { createModelStepCompactionController } from "../context/model-step-compaction.js";
import { assertSuperCompactionCheckpointIntegrity, assertSuperCompactionSourceIntegrity } from "../context/semantic-compaction/super-source-integrity.js";
import { captureRequestContextCompaction } from "../context/semantic-compaction/snapshot.js";
import { estimateMessageTokens } from "../context/token-estimator.js";
import { AVAILABLE_SKILLS_MAX_TOKENS } from "../knowledge-skills/available-skills-projection.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createRequestExecutionScope } from "../request/execution-scope.js";
import { parseSupervisorSkillAuthoringOutput } from "../steps/supervisor-skill-authoring/contract.js";
import { buildSupervisorSkillAuthoringInput } from "../steps/supervisor-skill-authoring/input.js";
import { activeCoreSkillCall, commitSkillFixture, CORE_SKILL_DOCUMENT, CORE_SKILL_PADDING, createCoreSkillContextFixture } from "./support/core-skill-read-context-fixture.js";
import { COMPACTION_FACT } from "./support/semantic-compaction-contract-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());
const availableSkillWriteOperationIds = ["create_skill", "update_skill"];

test("authoring receives attachments, history, captured guidance and canonical source returns before budget", async () => {
  const fixture = await createCoreSkillContextFixture();
  await fixture.read();
  const worker = await fixture.open("worker");
  await commitSkillFixture(fixture.ledger, {
    authority: "active_role", type: "begin_capability_execution", callId: worker.callId,
    invocationAttempt: worker.activationCount, capabilityId: "fixture.research", declaredEffect: "observation",
    intent: "Collect the source fact.", controlsJson: "{}",
  });
  await commitSkillFixture(fixture.ledger, {
    authority: "runtime", type: "settle_capability_execution", callId: worker.callId,
    executionId: "capability-execution-1", outcome: "succeeded", observedEffect: "observation",
    summary: "CANONICAL_TOOL_FACT", referenceData: "PRIVATE_EXACT_WORKER_OUTPUT",
    exactResult: { kind: "generic_capability_result_v1", authority: "capability_adapter", status: "executed", ok: true,
      payload: { fact: "PRIVATE_EXACT_WORKER_OUTPUT" } },
  });
  await fixture.finish();
  // A later reference read must not lose completed child source context.
  await fixture.read();
  const attachment: ModelGatewayAttachment = { id: "source-image", kind: "image", mimeType: "image/png",
    storageRef: "source-image.png", data: "aW1hZ2U=" };
  const store = { list: () => [CORE_SKILL_DOCUMENT], read: vi.fn(),
    create: async () => { throw new Error("not a selection action"); },
    update: async () => { throw new Error("not a selection action"); } };
  const request = createRequestExecutionScope({
    seed: { ...fixture.request, attachments: [attachment], historyMessages: [
      { id: "prior-user", role: "user", content: "REUSABLE_REQUESTED_CONVENTION", createdAt: "2026-10-18T00:00:00Z" },
      { id: "prior-answer", role: "assistant", content: "Discussed source guidance.", createdAt: "2026-10-18T00:00:01Z" },
    ] }, executionPolicy: fixture.request.executionPolicy, knowledgeSkillStore: store,
    createWorkerCapabilities: () => fixture.request.workerCapabilities.provider,
  });
  const head = fixture.ledger.current();
  const call = activeCoreSkillCall(fixture.ledger);
  const input = buildSupervisorSkillAuthoringInput(request, {
    skillReadHead: head, toolResults: fixture.toolResults(), availableSkillWriteOperationIds,
    diagnostic: { requestId: request.requestId, modelStep: "supervisor.decision", callId: call.callId, invocationAttempt: call.activationCount },
  });
  const messages = input.context.messages;
  const text = JSON.stringify(messages);
  expect(messages.find((message) => message.content === request.prompt)).toMatchObject({ attachments: [attachment] });
  expect(text).toContain("REUSABLE_REQUESTED_CONVENTION");
  expect(text).toContain(CORE_SKILL_PADDING);
  expect(text).toContain("CANONICAL_TOOL_FACT");
  expect(text).toContain('runtime_child_result');
  expect(text).toContain("The target was checked.");
  expect(text).not.toContain("PRIVATE_EXACT_WORKER_OUTPUT");
  expect(input.context.budget.parts.referenceInputTokens).toBeGreaterThan(0);
  expect(input.context.budget.parts.continuationInputTokens).toBeGreaterThan(0);
  expect(store.read).not.toHaveBeenCalled();

  const controller = createModelStepCompactionController(request, {
    consumer: "supervisor.decision", call: { roleId: "supervisor", callId: call.callId, objective: request.prompt },
    sourceRevision: head.revision, allowedConsumers: ["supervisor.decision", "supervisor.response"],
  });
  const compacted = await controller.getStages()[0]!.prepare(messages);
  expect(compacted.kind).toBe("prepared");
  if (compacted.kind !== "prepared") throw new Error("expected_compaction");
  compacted.preparation.commit();
  expect(JSON.stringify(compacted.preparation.messages)).toContain(COMPACTION_FACT);
  expect(compacted.preparation.messages.find((message) => message.content === request.prompt)).toMatchObject({ attachments: [attachment] });
  const snapshot = captureRequestContextCompaction(fixture.store);
  expect(snapshot.sources.some(({ sourceRef }) => sourceRef.startsWith("child-result:"))).toBe(true);
  const integrity = { requestId: request.requestId, prompt: request.prompt, head, store: fixture.store };
  expect(() => assertSuperCompactionSourceIntegrity(integrity)).not.toThrow();
  expect(() => assertSuperCompactionCheckpointIntegrity({ ...integrity, checkpoint: snapshot.checkpoints[0]! })).not.toThrow();
});

test("bounded personal metadata offers only displayed exact IDs without reading documents", async () => {
  const fixture = await createCoreSkillContextFixture();
  const skills = Array.from({ length: 20 }, (_, index) => ({ ...CORE_SKILL_DOCUMENT,
    skillId: `personal-${index}`, name: `Procedure ${index}`, description: "Applicability detail. ".repeat(20) }));
  const system = { ...CORE_SKILL_DOCUMENT, skillId: "system-guide", source: "system" as const };
  const store = { list: () => [system, ...skills], read: vi.fn(),
    create: async () => { throw new Error("not used"); }, update: async () => { throw new Error("not used"); } };
  const request = createRequestExecutionScope({ seed: fixture.request, executionPolicy: fixture.request.executionPolicy,
    knowledgeSkillStore: store, createWorkerCapabilities: () => fixture.request.workerCapabilities.provider });
  const input = buildSupervisorSkillAuthoringInput(request, {
    toolResults: fixture.toolResults(), availableSkillWriteOperationIds,
    diagnostic: { requestId: request.requestId, modelStep: "supervisor.decision" },
  });
  const message = input.context.messages.find(({ content }) => content.includes('"kind":"runtime_personal_skill_metadata_v1"'))!;
  const catalog = JSON.parse(message.content) as { skills: { skillId: string }[]; partial: boolean };
  expect(catalog.partial).toBe(true);
  expect(catalog.skills.length).toBeGreaterThan(0);
  expect(estimateMessageTokens(message)).toBeLessThanOrEqual(AVAILABLE_SKILLS_MAX_TOKENS);
  expect(input.authoringOptions.personalSkills.map(({ skillId }) => skillId)).toEqual(catalog.skills.map(({ skillId }) => skillId));
  expect(parseSupervisorSkillAuthoringOutput(JSON.stringify({ decision: { action: "update_skill", skillId: "system-guide" } }), input.authoringOptions).ok).toBe(false);
  expect(parseSupervisorSkillAuthoringOutput(JSON.stringify({ decision: { action: "update_skill", skillId: "personal-19" } }), input.authoringOptions).ok).toBe(false);
  expect(store.read).not.toHaveBeenCalled();
});
