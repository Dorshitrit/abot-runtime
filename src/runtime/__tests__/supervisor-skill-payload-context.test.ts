import { afterEach, beforeEach, expect, test } from "vitest";
import type { ChatMessage, ModelGatewayAttachment } from "../../model-gateway/types.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { buildCoreSkillReadContextMessages, CORE_SKILL_READ_MESSAGE_KIND } from "../context/core-skill-read-context.js";
import { bindSuperWorkerCompactionSources, readSuperWorkerCompactionSidecar } from "../context/super-worker-compaction-sidecar.js";
import { createSemanticCompactionSha256Fingerprint as hash } from "../context/semantic-compaction/contracts.js";
import { captureRequestContextCompaction } from "../context/semantic-compaction/snapshot.js";
import { assertSuperCompactionCheckpointBinding, assertSuperCompactionCheckpointIntegrity } from "../context/semantic-compaction/super-source-integrity.js";
import { createRoleCallLedger } from "../orchestration/role-calls/index.js";
import { captureRoleCallLedgerCheckpoint } from "../orchestration/role-calls/checkpoint.js";
import { createPreparationId } from "../orchestration/worker-capabilities/execution/invocation-preparation.js";
import { projectRoleSettledCapabilityResults } from "../orchestration/worker-capabilities/settled-results.js";
import type { WorkerCapabilityPayloadAuthor } from "../orchestration/worker-capabilities/payload-contracts.js";
import { createRequestRoleCallPolicy } from "../request/role-call-policy.js";
import { restoreApprovalCompaction } from "../request/approval-wait/super-compaction-restore.js";
import { createRequestWorkerCapabilityPayloadAuthor } from "../request/worker-capability-payload.js";
import { createRequestExecutionScope, type RequestExecutionScope } from "../request/execution-scope.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";
import { COMPACTION_FACT, semanticContractFixture } from "./support/semantic-compaction-contract-fixture.js";
import { activeCoreSkillCall, commitSkillFixture, createCoreSkillContextFixture, CORE_SKILL_PADDING, CORE_SKILL_DOCUMENT } from "./support/core-skill-read-context-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

type Fixture = Awaited<ReturnType<typeof createCoreSkillContextFixture>>;
type PayloadInput = Parameters<WorkerCapabilityPayloadAuthor["author"]>[0];

function rootPayloadInput(fixture: Fixture, contextScope: "standard" | "target_only" = "standard"): PayloadInput {
  const call = activeCoreSkillCall(fixture.ledger);
  return {
    call, executionId: createPreparationId(call, 0), contextScope,
    authoringObjective: "Write the requested reusable guidance.",
    descriptor: {
      capabilityId: "create_skill", summary: "Save personal guidance.", effect: "mutation",
      requiresPayloadAuthoringObjective: true,
      controls: { type: "object", additionalProperties: false, properties: {}, required: [] },
    },
    controls: {},
    settledCapabilityResults: bindSuperWorkerCompactionSources([...projectRoleSettledCapabilityResults({
      ledger: fixture.ledger, head: fixture.ledger.current(), call,
    })], fixture.ledger.current(), call.callId),
    contract: { instructions: "Return the complete Markdown document.", minBytes: 1, maxBytes: 4096 },
    requestSteering: { kind: "request_steering_v1", version: 1,
      updates: [{ sequence: 1, text: "Keep the document concise." }] },
    ...(contextScope === "target_only" ? {
      stage: { index: 1, count: 1, outputParam: "content", contextScope },
      targetContext: { targetParam: "skillId", targetPath: "personal-guidance", presentation: "full" as const,
        content: "Current personal guidance." },
    } : {}),
  };
}

function capsules(messages: readonly ChatMessage[]) {
  return messages.filter(({ content }) => content.includes(`"kind":"${CORE_SKILL_READ_MESSAGE_KIND}"`));
}

async function compactedRootFixture() {
  const fixture = await createCoreSkillContextFixture();
  await fixture.read();
  const count = fixture.countInputTokens.getMockImplementation()!;
  fixture.countInputTokens.mockImplementation(async (input) => {
    if (input.modelStep !== "tool_payload.raw") return count(input);
    return { inputTokens: JSON.stringify(input.messages).includes(CORE_SKILL_PADDING) ? 64_000 : 1_000,
      profileId: "contract-model", provider: "openai", model: "contract-test",
      contextWindowTokens: 64_000, source: "provider_input_token_count" };
  });
  const input = rootPayloadInput(fixture);
  const author = createRequestWorkerCapabilityPayloadAuthor(fixture.request, ["root", "worker"]);
  expect(await author.author(input)).toMatchObject({ status: "authored" });
  const snapshot = captureRequestContextCompaction(fixture.store);
  expect(snapshot.checkpoints).toHaveLength(1);
  return { ...fixture, author, payloadInput: input, snapshot, checkpoint: snapshot.checkpoints[0]! };
}

test.each(["standard", "target_only"] as const)(
  "SUPER root RAW %s uses existing Skill transport before budgeting without exposing the sidecar",
  async (scope) => {
    const fixture = await createCoreSkillContextFixture();
    await fixture.read();
    expect(readSuperWorkerCompactionSidecar(fixture.toolResults())).toBeUndefined();
    const input = rootPayloadInput(fixture, scope);
    const author = createRequestWorkerCapabilityPayloadAuthor(fixture.request, ["root", "worker"]);
    expect(await author.author(input)).toMatchObject({ status: "authored" });
    const messages = fixture.modelInputs.find(({ step }) => step === "tool_payload.raw")!.messages;
    expect(capsules(messages)).toEqual(scope === "standard"
      ? buildCoreSkillReadContextMessages(fixture.ledger.current(), "delegate") : []);
    const context = JSON.parse(messages.find(({ content }) => content.startsWith("Canonical runtime context:\n"))!
      .content.slice("Canonical runtime context:\n".length));
    expect(context.root.updates).toEqual(input.requestSteering!.updates);
    expect(context.acceptedCapability.authoringObjective).toBe(input.authoringObjective);
    expect(JSON.stringify(messages)).toContain(fixture.request.prompt);
    expect(JSON.stringify(messages)).not.toContain("superWorkerCompaction");
    expect(context).not.toHaveProperty("coreSkillReads");
    expect(fixture.countInputTokens.mock.calls.some(([request]) => request.modelStep === "tool_payload.raw" &&
      capsules(request.messages as readonly ChatMessage[]).length === (scope === "standard" ? 1 : 0))).toBe(true);
  },
);

test("SUPER root RAW compacts canonical Skill bytes in an isolated scope and restores after write admission", async () => {
  const fixture = await compactedRootFixture();
  const { payloadInput: input, checkpoint, snapshot } = fixture;
  const raw = fixture.modelInputs.find(({ step }) => step === "tool_payload.raw")!.messages;
  expect(JSON.stringify(raw)).toContain(COMPACTION_FACT);
  expect(JSON.stringify(raw)).not.toContain(CORE_SKILL_PADDING);
  expect(checkpoint).toMatchObject({
    roleId: "supervisor", callId: input.call.callId,
    scopeId: `payload:${input.call.callId}:${input.executionId}:0`,
    allowedConsumers: ["tool_payload.raw"], objectiveFingerprint: hash(fixture.request.prompt),
  });
  expect(snapshot.sources.map(({ content }) => content)).toEqual(
    buildCoreSkillReadContextMessages(fixture.ledger.current(), "delegate").map((message) => JSON.stringify(message)));
  const integrity = { requestId: fixture.request.requestId, prompt: fixture.request.prompt, store: fixture.store };
  expect(() => assertSuperCompactionCheckpointIntegrity({ ...integrity, head: fixture.ledger.current(), checkpoint })).not.toThrow();
  await commitSkillFixture(fixture.ledger, {
    authority: "active_role", type: "begin_capability_execution", callId: input.call.callId,
    invocationAttempt: input.call.activationCount, capabilityId: "create_skill", declaredEffect: "mutation",
    intent: "Save the requested Skill.", controlsJson: "{}",
  });
  const restoreInput = {
    requestId: fixture.request.requestId, prompt: fixture.request.prompt,
    executionPolicy: fixture.request.executionPolicy,
    ledgerCheckpoint: JSON.parse(JSON.stringify(captureRoleCallLedgerCheckpoint(fixture.ledger))),
  };
  const invokeCount = fixture.invoke.mock.calls.length;
  expect(restoreApprovalCompaction({ ...restoreInput, snapshot: JSON.parse(JSON.stringify(snapshot)) }).snapshot!())
    .toEqual(snapshot);
  expect(fixture.invoke.mock.calls).toHaveLength(invokeCount);
  const original = snapshot.sources[0]!;
  const content = original.content.replace(COMPACTION_FACT, "Forged guidance.");
  const sourceFingerprint = hash(content);
  expect(() => restoreApprovalCompaction({ ...restoreInput, snapshot: {
    ...snapshot, sources: [{ ...original, content, sourceFingerprint }],
    checkpoints: [{ ...checkpoint, sourceDigests: checkpoint.sourceDigests.map((digest) => ({ ...digest, sourceFingerprint })) }],
  } })).toThrow("context_compaction_snapshot_source_incompatible");
  await commitSkillFixture(fixture.ledger, {
    authority: "runtime", type: "settle_capability_execution", callId: input.call.callId,
    executionId: fixture.ledger.current().state.capabilityExecutions[0]!.executionId,
    outcome: "succeeded", observedEffect: "mutation", summary: "Skill saved.",
    exactResult: { kind: "generic_capability_result_v1", authority: "capability_adapter",
      status: "executed", ok: true, payload: { skillId: "saved-guidance" } },
  });
  expect(activeCoreSkillCall(fixture.ledger).activationCount).toBeGreaterThan(input.call.activationCount);
  expect(() => assertSuperCompactionCheckpointIntegrity({ ...integrity, head: fixture.ledger.current(), checkpoint })).not.toThrow();
  expect(await fixture.author.author(rootPayloadInput(fixture))).toMatchObject({ status: "authored" });
  const next = captureRequestContextCompaction(fixture.store);
  const execution = fixture.ledger.current().state.capabilityExecutions[0]!;
  expect(JSON.parse(next.sources.find(({ sourceRef }) => sourceRef === execution.executionId)!.content))
    .toMatchObject({ callId: input.call.callId, adapterResult: execution.exactResult });
  expect(next.checkpoints).toHaveLength(2);
  for (const captured of next.checkpoints)
    expect(() => assertSuperCompactionCheckpointIntegrity({ ...integrity, head: fixture.ledger.current(), checkpoint: captured }))
      .not.toThrow();
});

test("SUPER root RAW rejects foreign and future preparation bindings, keeping its checkpoint out of continuation", async () => {
  const fixture = await compactedRootFixture();
  const { checkpoint, payloadInput: input } = fixture;
  const params = { requestId: fixture.request.requestId, prompt: fixture.request.prompt, head: fixture.ledger.current() };
  const invalidScopes = [
    `worker:${input.call.callId}:request-tool-results`,
    `payload:${input.call.callId}:capability-execution-1:0`,
    `payload:${input.call.callId}:capability-preparation:foreign:1:1:0`,
    `payload:${input.call.callId}:capability-preparation:${input.call.callId}:${input.call.activationCount + 1}:1:0`,
    `payload:${input.call.callId}:capability-preparation:${input.call.callId}:${input.call.activationCount}:2:0`,
  ];
  for (const scopeId of invalidScopes)
    expect(() => assertSuperCompactionCheckpointBinding({ ...params, checkpoint: { ...checkpoint, scopeId } }))
      .toThrow("context_compaction_checkpoint_scope_invalid");
  expect(() => assertSuperCompactionCheckpointBinding({ ...params,
    checkpoint: { ...checkpoint, allowedConsumers: ["supervisor.decision"] } }))
    .toThrow("context_compaction_checkpoint_consumers_invalid");
  expect(() => assertSuperCompactionCheckpointBinding({ ...params,
    checkpoint: { ...checkpoint, roleId: "root" } }))
    .toThrow("context_compaction_checkpoint_role_invalid");
});

test("SUPER root payload failure quarantines only its owned RAW checkpoint before admission", async () => {
  const fixture = await compactedRootFixture();
  fixture.store.commit({ ...fixture.checkpoint, sourceRevision: fixture.ledger.current().revision + 100 });
  const invokeCount = fixture.invoke.mock.calls.length;
  expect(await fixture.author.author(fixture.payloadInput)).toMatchObject({ status: "failed" });
  expect(fixture.invoke.mock.calls).toHaveLength(invokeCount);
  const snapshot = captureRequestContextCompaction(fixture.store);
  expect(snapshot.checkpoints).toEqual([]);
  expect(snapshot.invalidatedScopes).toEqual([expect.objectContaining({
    scopeId: fixture.checkpoint.scopeId,
    binding: expect.objectContaining({ roleId: "supervisor", callId: fixture.payloadInput.call.callId,
      allowedConsumers: ["tool_payload.raw"] }),
    failureCode: "context_compaction_checkpoint_revision_invalid",
  })]);
  expect(snapshot.sources).toEqual(fixture.snapshot.sources);
  expect(fixture.ledger.current().state.capabilityExecutions).toEqual([]);
});

test("EA root payload carriers do not acquire SUPER Skill sources or failure ownership", async () => {
  const fixture = semanticContractFixture({ policy: "execution-agent-v1" });
  const request = fixture.params.request as RequestExecutionScope;
  const ledger = createRoleCallLedger({ requestId: request.requestId,
    policy: createRequestRoleCallPolicy(request.executionPolicy) });
  await commitSkillFixture(ledger, { authority: "runtime", type: "create_root" });
  const carrier = bindSuperWorkerCompactionSources([], ledger.current(), ledger.current().state.rootCallId!);
  expect(readSuperWorkerCompactionSidecar(carrier)).toBeUndefined();
  expect(carrier).toEqual([]);
});

test.each([true, false])("SUPER Skill RAW carries child sources and attachments before admission, compaction=%s", async (compact) => {
  const fixture = await createCoreSkillContextFixture();
  const child = await fixture.open("worker");
  const detail = "completed-child-source-detail ".repeat(100).trim();
  await commitSkillFixture(fixture.ledger, { authority: "runtime", type: "return_child",
    callerCallId: child.parentCallId, childCallId: child.callId, outcome: "completed",
    summary: `${COMPACTION_FACT}\n${detail}` });
  const attachment: ModelGatewayAttachment = { id: "skill-source", kind: "file", mimeType: "application/pdf",
    name: "source.pdf", storageRef: "attachments/source.pdf" };
  const request = deriveTestRequestExecutionScope(fixture.request, { attachments: [attachment] });
  const count = fixture.countInputTokens.getMockImplementation()!;
  fixture.countInputTokens.mockImplementation(async (input) => input.modelStep !== "tool_payload.raw" ? count(input) : {
    inputTokens: compact && JSON.stringify(input.messages).includes(detail) ? 64_000 : 1_000,
    profileId: "contract-model", provider: "openai", model: "contract-test", contextWindowTokens: 64_000,
    source: "provider_input_token_count" });
  const input = rootPayloadInput(fixture);
  let author!: WorkerCapabilityPayloadAuthor;
  createRequestExecutionScope({ seed: request, executionPolicy: request.executionPolicy,
    createWorkerCapabilities(view) {
      author = createRequestWorkerCapabilityPayloadAuthor(view, ["root", "worker"]);
      return fixture.request.workerCapabilities.provider;
    } });
  expect(await author.author(input)).toMatchObject({ status: "authored" });
  const initial = fixture.countInputTokens.mock.calls.find(([input]) => input.modelStep === "tool_payload.raw")![0].messages as ChatMessage[];
  expect(JSON.stringify(initial)).toContain(detail);
  expect(initial.flatMap(({ attachments }) => attachments ?? [])).toEqual([attachment]);
  const messages = fixture.modelInputs.find(({ step }) => step === "tool_payload.raw")!.messages;
  expect(messages.flatMap(({ attachments }) => attachments ?? [])).toEqual([attachment]);
  expect(messages.find(({ attachments }) => attachments?.length)?.content).toContain('"kind":"runtime_request_source_v1"');
  expect(messages.find(({ content }) => content.startsWith("Canonical runtime context:"))?.attachments).toBeUndefined();
  expect(JSON.stringify(messages)).toContain(COMPACTION_FACT);
  const snapshot = captureRequestContextCompaction(fixture.store);
  expect(snapshot.checkpoints).toHaveLength(compact ? 1 : 0);
  if (!compact) return;
  expect(JSON.stringify(messages)).not.toContain(detail);
  expect(snapshot.sources).toHaveLength(1);
  expect(snapshot.sources[0]!.sourceRef).toBe(`child-result:${fixture.ledger.current().state.results[0]!.resultRef}`);
  expect(() => assertSuperCompactionCheckpointIntegrity({ requestId: request.requestId, prompt: request.prompt,
    head: fixture.ledger.current(), store: fixture.store, checkpoint: snapshot.checkpoints[0]! })).not.toThrow();
  await commitSkillFixture(fixture.ledger, { authority: "active_role", type: "begin_capability_execution",
    callId: input.call.callId, invocationAttempt: input.call.activationCount, capabilityId: "create_skill",
    declaredEffect: "mutation", intent: "Save the requested Skill.", controlsJson: "{}" });
  expect(restoreApprovalCompaction({ requestId: request.requestId, prompt: request.prompt,
    executionPolicy: request.executionPolicy, ledgerCheckpoint: JSON.parse(JSON.stringify(captureRoleCallLedgerCheckpoint(fixture.ledger))),
    snapshot: JSON.parse(JSON.stringify(snapshot)) }).snapshot!()).toEqual(snapshot);
});

test("unrelated root payloads retain their existing source boundary", async () => {
  const fixture = await createCoreSkillContextFixture();
  await fixture.open("worker");
  await fixture.finish();
  const attachment: ModelGatewayAttachment = { id: "unrelated-source", kind: "image", mimeType: "image/png",
    storageRef: "attachments/unrelated.png" };
  const request = deriveTestRequestExecutionScope(fixture.request, { attachments: [attachment] });
  const input = rootPayloadInput(fixture);
  const author = createRequestWorkerCapabilityPayloadAuthor(request, ["root", "worker"]);
  expect(await author.author({ ...input, descriptor: { ...input.descriptor, capabilityId: "write_file" } }))
    .toMatchObject({ status: "authored" });
  const messages = fixture.modelInputs.find(({ step }) => step === "tool_payload.raw")!.messages;
  expect(messages.flatMap(({ attachments }) => attachments ?? [])).toEqual([]);
  expect(JSON.stringify(messages)).not.toContain('"kind":"runtime_child_result"');
});

test("SUPER edit RAW preserves the full captured target while compacting other guidance", async () => {
  const fixture = await createCoreSkillContextFixture();
  await fixture.open("worker");
  await fixture.finish();
  const otherDetail = "other-guidance-detail ".repeat(100);
  await fixture.read([CORE_SKILL_DOCUMENT, {
    skillId: "other-guidance", name: "Other guidance", description: "Another applicable procedure.",
    source: "system", content: `${COMPACTION_FACT}\n${otherDetail}`,
  }]);
  const count = fixture.countInputTokens.getMockImplementation()!;
  fixture.countInputTokens.mockImplementation(async (input) => input.modelStep !== "tool_payload.raw" ? count(input) : {
    inputTokens: JSON.stringify(input.messages).includes(otherDetail) ? 64_000 : 1_000,
    profileId: "contract-model", provider: "openai", model: "contract-test", contextWindowTokens: 64_000,
    source: "provider_input_token_count",
  });
  const base = rootPayloadInput(fixture);
  const input: PayloadInput = {
    ...base, descriptor: { ...base.descriptor, capabilityId: "update_skill" },
    controls: { skillId: CORE_SKILL_DOCUMENT.skillId, expectedRevision: CORE_SKILL_DOCUMENT.revision! },
  };
  const author = createRequestWorkerCapabilityPayloadAuthor(fixture.request, ["root", "worker"]);
  expect(await author.author(input)).toMatchObject({ status: "authored" });
  const initial = fixture.countInputTokens.mock.calls.find(([entry]) => entry.modelStep === "tool_payload.raw")![0].messages as ChatMessage[];
  const messages = fixture.modelInputs.find(({ step }) => step === "tool_payload.raw")!.messages;
  for (const projected of [initial, messages]) {
    const target = projected.find(({ content }) => content.startsWith('{"kind":"runtime_payload_target_content_v1"'))!;
    expect(target.content.slice(target.content.indexOf("\n") + 1)).toBe(CORE_SKILL_DOCUMENT.content);
    expect(capsules(projected).map(({ content }) => JSON.parse(content).document.skillId))
      .not.toContain(CORE_SKILL_DOCUMENT.skillId);
    const context = JSON.parse(projected.find(({ content }) => content.startsWith("Canonical runtime context:\n"))!
      .content.slice("Canonical runtime context:\n".length));
    expect(context.acceptedCapability.controls).toEqual(input.controls);
    expect(context.payloadStage).toEqual({ index: 1, count: 1, outputParam: "content" });
    expect(context.targetContext).toMatchObject({ targetParam: "skillId", targetPath: CORE_SKILL_DOCUMENT.skillId,
      presentation: "full", contentRef: "runtime_payload_target_content_v1" });
  }
  expect(JSON.stringify(messages)).not.toContain(otherDetail);
  const snapshot = captureRequestContextCompaction(fixture.store);
  expect(snapshot.checkpoints).toHaveLength(1);
  expect(snapshot.checkpoints[0]!.scopeId).toBe(`payload:${input.call.callId}:${input.executionId}:1`);
  expect(snapshot.sources).toHaveLength(2);
  const guidance = snapshot.sources.find(({ sourceRef }) => sourceRef.startsWith("core-skill-read:"))!;
  expect(JSON.parse(JSON.parse(guidance.content).content).document.skillId).toBe("other-guidance");
  expect(snapshot.sources.some(({ sourceRef }) => sourceRef.startsWith("child-result:"))).toBe(true);
  expect(() => assertSuperCompactionCheckpointIntegrity({ requestId: fixture.request.requestId,
    prompt: fixture.request.prompt, head: fixture.ledger.current(), store: fixture.store,
    checkpoint: snapshot.checkpoints[0]! })).not.toThrow();
  await commitSkillFixture(fixture.ledger, { authority: "active_role", type: "begin_capability_execution",
    callId: input.call.callId, invocationAttempt: input.call.activationCount, capabilityId: "update_skill",
    declaredEffect: "mutation", intent: "Update the requested Skill.", controlsJson: JSON.stringify(input.controls) });
  expect(restoreApprovalCompaction({ requestId: fixture.request.requestId, prompt: fixture.request.prompt,
    executionPolicy: fixture.request.executionPolicy, ledgerCheckpoint: JSON.parse(JSON.stringify(captureRoleCallLedgerCheckpoint(fixture.ledger))),
    snapshot: JSON.parse(JSON.stringify(snapshot)) }).snapshot!()).toEqual(snapshot);
});

test("SUPER edit RAW refuses a missing or mismatched captured revision before invoking the model", async () => {
  const fixture = await createCoreSkillContextFixture();
  await fixture.read();
  const input = rootPayloadInput(fixture);
  const author = createRequestWorkerCapabilityPayloadAuthor(fixture.request, ["root", "worker"]);
  for (const controls of [
    { skillId: CORE_SKILL_DOCUMENT.skillId, expectedRevision: 2 },
    { skillId: "missing-personal-skill", expectedRevision: 1 },
  ]) {
    expect(() => author.author({ ...input, descriptor: { ...input.descriptor, capabilityId: "update_skill" }, controls }))
      .toThrow("supervisor_skill_edit_target_revision_mismatch");
  }
  expect(fixture.invoke).not.toHaveBeenCalled();
  expect(fixture.countInputTokens).not.toHaveBeenCalled();
});

test("SUPER edit RAW rejects a target that cannot fit instead of replacing it from a compacted summary", async () => {
  const fixture = await createCoreSkillContextFixture();
  await fixture.read();
  const count = fixture.countInputTokens.getMockImplementation()!;
  fixture.countInputTokens.mockImplementation(async (input) => input.modelStep !== "tool_payload.raw" ? count(input) : {
    inputTokens: 64_000, profileId: "contract-model", provider: "openai", model: "contract-test",
    contextWindowTokens: 64_000, source: "provider_input_token_count",
  });
  const input = rootPayloadInput(fixture);
  const author = createRequestWorkerCapabilityPayloadAuthor(fixture.request, ["root", "worker"]);
  expect(await author.author({ ...input, descriptor: { ...input.descriptor, capabilityId: "update_skill" },
    controls: { skillId: CORE_SKILL_DOCUMENT.skillId, expectedRevision: CORE_SKILL_DOCUMENT.revision! } }))
    .toMatchObject({ status: "failed", code: "payload_context_budget_exceeded" });
  expect(fixture.modelInputs).toEqual([]);
  expect(captureRequestContextCompaction(fixture.store).checkpoints).toEqual([]);
});
