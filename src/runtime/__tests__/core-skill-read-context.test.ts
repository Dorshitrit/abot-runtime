import { afterEach, beforeEach, expect, test } from "vitest";
import type { ModelStep } from "../../shared/model-steps.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { buildCoreSkillReadContextMessages, CORE_SKILL_READ_MESSAGE_KIND } from "../context/core-skill-read-context.js";
import { createModelStepCompactionController } from "../context/model-step-compaction.js";
import { superCompactionFailureOwner } from "../context/super-compaction-failure-owner.js";
import { bindSuperWorkerCompactionSources, readSuperWorkerCompactionSidecar } from "../context/super-worker-compaction-sidecar.js";
import { createSemanticCompactionSha256Fingerprint as hash } from "../context/semantic-compaction/contracts.js";
import { captureRequestContextCompaction } from "../context/semantic-compaction/snapshot.js";
import { assertSuperCompactionCheckpointIntegrity, assertSuperCompactionSourceIntegrity } from "../context/semantic-compaction/super-source-integrity.js";
import { captureRoleCallLedgerCheckpoint } from "../orchestration/role-calls/checkpoint.js";
import { WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS } from "../orchestration/worker-capabilities/index.js";
import { restoreApprovalCompaction } from "../request/approval-wait/super-compaction-restore.js";
import { buildSupervisorResponseInput, buildSupervisorMemoryAuthoringInput } from "../steps/supervisor-response/input.js";
import { runWorkerResultAuthor } from "../steps/worker-decision/result-author.js";
import { createRequestWorkerCapabilityPayloadAuthor } from "../request/worker-capability-payload.js";
import { projectWorkerCapabilityPayloadSourceProvenance } from "../orchestration/worker-capabilities/payload-source-provenance.js";
import { COMPACTION_FACT } from "./support/semantic-compaction-contract-fixture.js";
import {
  activeCoreSkillCall, commitSkillFixture, createCoreSkillContextFixture,
  CORE_SKILL_DOCUMENT, CORE_SKILL_OBJECTIVE, CORE_SKILL_PADDING,
} from "./support/core-skill-read-context-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

type Fixture = Awaited<ReturnType<typeof createCoreSkillContextFixture>>;
function capsules(messages: readonly ChatMessage[]) {
  return messages.filter((message) => message.content.includes(`"kind":"${CORE_SKILL_READ_MESSAGE_KIND}"`));
}

function skillActions(messages: readonly ChatMessage[]) {
  return messages.filter((message) => message.role === "assistant" &&
    /"action":"(?:list_skills|read_skills)"/.test(message.content));
}

function controller(fixture: Fixture) {
  const call = activeCoreSkillCall(fixture.ledger);
  const role = call.roleId as "supervisor" | "planner" | "worker";
  const modelStep = `${role}.decision` as ModelStep;
  const scopeId = role === "worker" ? `worker:${call.callId}:request-tool-results`
    : `role:${role}:${call.callId}:continuation`;
  return createModelStepCompactionController(fixture.request, {
    consumer: modelStep,
    call: { ...call, objective: role === "supervisor" ? fixture.request.prompt : call.objective },
    sourceRevision: fixture.ledger.current().revision, scopeId,
    superWorkerCompaction: readSuperWorkerCompactionSidecar(fixture.toolResults()),
    superFailureOwner: superCompactionFailureOwner(fixture.request.executionPolicy.authority, {
      requestId: fixture.request.requestId, callId: call.callId, parentCallId: call.parentCallId,
      contractId: role === "supervisor" ? "supervisor" : `delegated.${role}`,
      invocationAttempt: call.activationCount, sourceRevision: fixture.ledger.current().revision,
      modelStep, phase: "compaction", scopeId,
    }),
    allowedConsumers: role === "worker" ? WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS
      : role === "supervisor" ? ["supervisor.decision", "supervisor.response"]
        : ["planner.decision", "planner.graph"],
  });
}

test("projects only explicitly read latest documents, with stable per-document identity", async () => {
  const fixture = await createCoreSkillContextFixture();
  expect(buildCoreSkillReadContextMessages(fixture.ledger.current())).toEqual([]);
  expect(capsules(fixture.input().context.messages)).toEqual([]);
  const second = { ...CORE_SKILL_DOCUMENT, skillId: "second", name: "Second", content: "Second guidance." };
  await fixture.read([CORE_SKILL_DOCUMENT, second]);
  const original = buildCoreSkillReadContextMessages(fixture.ledger.current(), "delegate");
  await fixture.read([{ ...CORE_SKILL_DOCUMENT, revision: 2, content: "Updated guidance." }]);
  const current = buildCoreSkillReadContextMessages(fixture.ledger.current(), "delegate");
  expect(current).toHaveLength(2);
  expect(current[0]).toEqual(original[1]);
  expect(JSON.stringify(current)).not.toContain(CORE_SKILL_PADDING);
  expect(JSON.parse(current[1]!.content)).toMatchObject({
    authority: "passive_reference", source: "core_skills_store", purpose: "skill_guidance",
    requestId: fixture.request.requestId,
    read: { readId: "skill-read-2", callId: "call-1", operation: "read_skills" },
    document: { skillId: CORE_SKILL_DOCUMENT.skillId, revision: 2, content: "Updated guidance." },
  });
  expect(current.every((message) => Object.isFrozen(message) && message.role === "user")).toBe(true);
});

test("places one accepted batch read and its unchanged results after the current request", async () => {
  const fixture = await createCoreSkillContextFixture();
  expect(skillActions(fixture.input().context.messages)).toEqual([]);
  const second = { ...CORE_SKILL_DOCUMENT, skillId: "second", name: "Second", content: "Second guidance." };
  await fixture.read([CORE_SKILL_DOCUMENT, second]);
  const exact = buildCoreSkillReadContextMessages(fixture.ledger.current());
  const messages = fixture.input().context.messages;
  const promptIndex = messages.findIndex((message) => message.role === "user" && message.content === fixture.request.prompt);
  expect(promptIndex).toBeGreaterThan(0);
  expect(messages.slice(promptIndex + 1)).toEqual([
    { role: "assistant", content: JSON.stringify({ decision: {
      action: "read_skills", skillIds: [CORE_SKILL_DOCUMENT.skillId, second.skillId],
    } }) },
    ...exact,
  ]);
  expect(capsules(messages.slice(0, promptIndex))).toEqual([]);
  expect(capsules(messages)).toEqual(exact);
  expect(new Set(capsules(messages).map((message) => message.content)).size).toBe(2);
  expect(messages.filter((message) => message.role === "user" && message.content === fixture.request.prompt)).toHaveLength(1);
});

test.each(["list_skills", "failed_read"] as const)(
  "keeps older guidance passive while presenting the immediate %s action and exact result",
  async (operation) => {
    const fixture = await createCoreSkillContextFixture();
    await fixture.read();
    const previous = buildCoreSkillReadContextMessages(fixture.ledger.current());
    const call = activeCoreSkillCall(fixture.ledger);
    const isList = operation === "list_skills";
    await commitSkillFixture(fixture.ledger, {
      authority: "runtime", type: "record_skill_read", callId: call.callId,
      invocationAttempt: call.activationCount, steeringVersion: 0,
      operation: isList ? "list_skills" : "read_skills", selectors: isList ? [] : ["missing"],
      result: isList ? { outcome: "completed", skills: [] }
        : { outcome: "failed", errorCode: "knowledge_skill_not_found", skills: [] },
    });
    const exact = buildCoreSkillReadContextMessages(fixture.ledger.current());
    const messages = fixture.input().context.messages;
    const promptIndex = messages.findIndex((message) => message.content === fixture.request.prompt);
    expect(capsules(messages.slice(0, promptIndex))).toEqual(previous);
    expect(messages.slice(promptIndex + 1)).toEqual([
      { role: "assistant", content: JSON.stringify({ decision: isList
        ? { action: "list_skills" } : { action: "read_skills", skillIds: ["missing"] } }) },
      exact[1],
    ]);
    expect(capsules(messages)).toEqual(exact);
    expect(JSON.parse(exact[1]!.content).read.result.outcome).toBe(isList ? "completed" : "failed");
  },
);

test("does not replay an old read after a child return and appends a new read after that return", async () => {
  const fixture = await createCoreSkillContextFixture();
  await fixture.read();
  const previous = buildCoreSkillReadContextMessages(fixture.ledger.current());
  await fixture.open("worker");
  const resume = await fixture.finish();
  const returned = fixture.input({ resume }).context.messages;
  const promptIndex = returned.findIndex((message) => message.content === fixture.request.prompt);
  expect(capsules(returned.slice(0, promptIndex))).toEqual(previous);
  expect(skillActions(returned)).toEqual([]);
  expect(returned.at(-1)!.content).toContain('"kind":"runtime_child_result"');

  const second = { ...CORE_SKILL_DOCUMENT, skillId: "second", name: "Second", content: "Follow-up guidance." };
  await fixture.read([second]);
  const messages = fixture.input({ resume: {
    ...resume, invocationAttempt: activeCoreSkillCall(fixture.ledger).activationCount,
  } }).context.messages;
  const exact = buildCoreSkillReadContextMessages(fixture.ledger.current());
  expect(messages.slice(-2)).toEqual([
    { role: "assistant", content: JSON.stringify({ decision: { action: "read_skills", skillIds: [second.skillId] } }) },
    exact[1],
  ]);
  expect(messages.at(-3)!.content).toContain('"kind":"runtime_child_result"');
  expect(capsules(messages.slice(0, messages.findIndex((message) => message.content === fixture.request.prompt))))
    .toEqual(previous);
  expect(capsules(messages)).toEqual(exact);
});

test("preserves recall continuation before a fresh read and never presents an older read as the latest action", async () => {
  const fixture = await createCoreSkillContextFixture();
  await fixture.read();
  const memoryRecallMessage = await fixture.recall();
  const recalled = fixture.input({ memoryRecallMessage }).context.messages;
  expect(skillActions(recalled)).toEqual([]);
  expect(recalled.at(-1)).toMatchObject({ role: "tool", toolName: "recall_memory" });
  expect(capsules(recalled)).toEqual(buildCoreSkillReadContextMessages(fixture.ledger.current()));

  await fixture.read([{ ...CORE_SKILL_DOCUMENT, revision: 2, content: "Updated guidance." }]);
  const messages = fixture.input({ memoryRecallMessage }).context.messages;
  const exact = buildCoreSkillReadContextMessages(fixture.ledger.current());
  expect(messages.at(-3)).toMatchObject({ role: "tool", toolName: "recall_memory" });
  expect(messages.slice(-2)).toEqual([
    { role: "assistant", content: JSON.stringify({ decision: { action: "read_skills", skillIds: [CORE_SKILL_DOCUMENT.skillId] } }) },
    exact[0],
  ]);
  expect(messages.filter((message) => message.role === "tool")).toHaveLength(1);
  expect(capsules(messages)).toEqual(exact);
  const nextRecall = await fixture.recall();
  const afterRecall = fixture.input({ memoryRecallMessage: nextRecall }).context.messages;
  expect(skillActions(afterRecall)).toEqual([]);
  expect(capsules(afterRecall)).toEqual(exact);
});

test("keeps metadata and failures at the root and excludes Skill bodies from memory authoring", async () => {
  const fixture = await createCoreSkillContextFixture();
  const { content: _content, revision: _revision, ...metadata } = CORE_SKILL_DOCUMENT;
  await commitSkillFixture(fixture.ledger, {
    authority: "runtime", type: "record_skill_read", callId: "call-1", invocationAttempt: 1,
    steeringVersion: 0, operation: "list_skills", selectors: [],
    result: { outcome: "completed", skills: [metadata] },
  });
  await commitSkillFixture(fixture.ledger, {
    authority: "runtime", type: "record_skill_read", callId: "call-1", invocationAttempt: 2,
    steeringVersion: 0, operation: "read_skills", selectors: ["missing"],
    result: { outcome: "failed", skills: [], errorCode: "knowledge_skill_not_found" },
  });
  expect(buildCoreSkillReadContextMessages(fixture.ledger.current())).toHaveLength(2);
  expect(buildCoreSkillReadContextMessages(fixture.ledger.current(), "delegate")).toEqual([]);
  await fixture.read();
  const call = activeCoreSkillCall(fixture.ledger);
  const options = {
    call: { rootCallId: call.callId, callId: call.callId, parentCallId: null, depth: 0, invocationAttempt: call.activationCount },
    toolResults: fixture.toolResults(), skillReadHead: fixture.ledger.current(),
  };
  expect(capsules(buildSupervisorResponseInput(fixture.request, options).context.messages)).toHaveLength(3);
  expect(capsules(buildSupervisorMemoryAuthoringInput(fixture.request, options).context.messages)).toEqual([]);
});

test("propagates exact read guidance to Planner, Worker decision, controls and result without copying objectives", async () => {
  const fixture = await createCoreSkillContextFixture();
  await fixture.read();
  const expected = buildCoreSkillReadContextMessages(fixture.ledger.current(), "delegate");
  await fixture.open("planner");
  expect(capsules(fixture.input().context.messages)).toEqual(expected);
  await fixture.open("worker");
  const decision = fixture.workerInput();
  const controls = fixture.workerInput(true);
  expect(controls.modelStep).toBe("capability.controls");
  expect(capsules(decision.context.messages)).toEqual(expected);
  expect(capsules(controls.context.messages)).toEqual(expected);
  expect(decision.resultAuthorSource.objective).toBe(CORE_SKILL_OBJECTIVE);
  await runWorkerResultAuthor(fixture.request, {
    diagnostic: decision.diagnostic, source: decision.resultAuthorSource,
  });
  expect(capsules(fixture.modelInputs.find((input) => input.step === "worker.result")!.messages)).toEqual(expected);
  expect(fixture.ledger.current().state.calls.filter((call) => call.roleId !== "supervisor")
    .map((call) => call.objective)).toEqual([CORE_SKILL_OBJECTIVE, CORE_SKILL_OBJECTIVE]);
  expect(fixture.ledger.current().state.capabilityExecutions).toEqual([]);
});

test("keeps a newer captured document explicit beside an older checkpoint with latest-read precedence", async () => {
  const fixture = await createCoreSkillContextFixture();
  await fixture.read();
  const first = await controller(fixture).getStages()[0]!.prepare(fixture.input().context.messages);
  if (first.kind !== "prepared") throw new Error("expected_compaction");
  first.preparation.commit();
  await fixture.read([{ ...CORE_SKILL_DOCUMENT, revision: 2, content: "Use the newly approved procedure." }]);
  const projected = controller(fixture).project(fixture.input().context.messages);
  expect(capsules(projected)).toHaveLength(1);
  expect(JSON.parse(capsules(projected)[0]!.content)).toMatchObject({
    read: { readId: "skill-read-2" }, document: { revision: 2, content: "Use the newly approved procedure." },
  });
  expect(JSON.stringify(projected)).toContain("core-skill-read:skill-read-1:personal-guidance");
  expect(JSON.stringify(projected)).not.toContain(CORE_SKILL_PADDING);
  expect(() => assertSuperCompactionSourceIntegrity({
    requestId: fixture.request.requestId, prompt: fixture.request.prompt,
    head: fixture.ledger.current(), store: fixture.store,
  })).not.toThrow();
});

test("reuses a checkpoint captured with passive Skill references before the request without changing source bytes", async () => {
  const fixture = await createCoreSkillContextFixture();
  await fixture.read();
  const current = fixture.input().context.messages;
  const exact = buildCoreSkillReadContextMessages(fixture.ledger.current());
  const withoutRead = current.filter((message) => !capsules([message]).length && !skillActions([message]).length);
  const promptIndex = withoutRead.findIndex((message) => message.content === fixture.request.prompt);
  const legacy = [
    ...withoutRead.slice(0, promptIndex), ...exact, ...withoutRead.slice(promptIndex),
  ];
  const compacted = await controller(fixture).getStages()[0]!.prepare(legacy);
  if (compacted.kind !== "prepared") throw new Error("expected_compaction");
  compacted.preparation.commit();
  const snapshot = captureRequestContextCompaction(fixture.store);
  const content = JSON.stringify(exact[0]);
  expect(snapshot.sources).toEqual([{
    sourceRef: "core-skill-read:skill-read-1:personal-guidance",
    sourceFingerprint: hash(content), content,
  }]);
  const projected = controller(fixture).project(current);
  expect(capsules(projected)).toEqual([]);
  expect(skillActions(projected)).toEqual(skillActions(current));
  expect(JSON.stringify(projected)).toContain(COMPACTION_FACT);
  expect(JSON.stringify(projected)).not.toContain(CORE_SKILL_PADDING);
  expect(projected.at(-1)!.content).toContain('"kind":"runtime_semantic_compaction_checkpoint_v2"');

  const worker = await fixture.open("worker");
  await commitSkillFixture(fixture.ledger, {
    authority: "active_role", type: "begin_capability_execution", callId: worker.callId,
    invocationAttempt: worker.activationCount, capabilityId: "fixture.save", declaredEffect: "mutation",
    intent: "Save the requested result.", controlsJson: "{}",
  });
  const restored = restoreApprovalCompaction({
    snapshot: JSON.parse(JSON.stringify(snapshot)),
    ledgerCheckpoint: JSON.parse(JSON.stringify(captureRoleCallLedgerCheckpoint(fixture.ledger))),
    requestId: fixture.request.requestId, prompt: fixture.request.prompt,
    executionPolicy: fixture.request.executionPolicy,
  });
  expect(restored.snapshot!()).toEqual(snapshot);
  expect(() => assertSuperCompactionCheckpointIntegrity({
    requestId: fixture.request.requestId, prompt: fixture.request.prompt,
    head: fixture.ledger.current(), store: restored, checkpoint: snapshot.checkpoints[0]!,
  })).not.toThrow();
});

test("retains both immutable read sources when one checkpoint covers passive and immediate guidance", async () => {
  const fixture = await createCoreSkillContextFixture();
  await fixture.read();
  await fixture.read([{ ...CORE_SKILL_DOCUMENT, skillId: "second", name: "Second" }]);
  const messages = fixture.input().context.messages;
  const exact = buildCoreSkillReadContextMessages(fixture.ledger.current());
  const outcome = await controller(fixture).getStages()[0]!.prepare(messages);
  if (outcome.kind !== "prepared") throw new Error("expected_compaction");
  outcome.preparation.commit();
  const snapshot = captureRequestContextCompaction(fixture.store);
  expect(snapshot.sources.map(({ content }) => content)).toEqual(exact.map((message) => JSON.stringify(message)));
  expect(snapshot.sources.map(({ sourceFingerprint }) => sourceFingerprint))
    .toEqual(exact.map((message) => hash(JSON.stringify(message))));
  expect(capsules(outcome.preparation.messages)).toEqual([]);
  expect(JSON.stringify(outcome.preparation.messages)).toContain(COMPACTION_FACT);
  expect(JSON.stringify(outcome.preparation.messages)).not.toContain(CORE_SKILL_PADDING);
  const checkpoint = outcome.preparation.messages.find((message) => message.content.includes('"kind":"runtime_semantic_compaction_checkpoint_v2"'))!;
  expect(JSON.parse(checkpoint.content).coveredSources.map((source: { sourceRef: string }) => source.sourceRef))
    .toEqual(snapshot.sources.map(({ sourceRef }) => sourceRef));
  expect(skillActions(outcome.preparation.messages)).toEqual(skillActions(messages));
});

test("preserves Skill digests and settled evidence when request tool results carry the checkpoint", async () => {
  const fixture = await createCoreSkillContextFixture();
  const worker = await fixture.open("worker");
  await commitSkillFixture(fixture.ledger, {
    authority: "active_role", type: "begin_capability_execution", callId: worker.callId,
    invocationAttempt: worker.activationCount, capabilityId: "fixture.inspect", declaredEffect: "observation",
    intent: "Inspect the requested target.", controlsJson: "{}",
  });
  await commitSkillFixture(fixture.ledger, {
    authority: "runtime", type: "settle_capability_execution", callId: worker.callId,
    executionId: fixture.ledger.current().state.capabilityExecutions[0]!.executionId,
    outcome: "succeeded", observedEffect: "observation", summary: "Observed the requested target.",
    exactResult: {
      kind: "generic_capability_result_v1", authority: "capability_adapter",
      status: "executed", ok: true, payload: { observed: "Target exists." },
    },
  });
  const resume = await fixture.finish();
  await fixture.read();
  const messages = fixture.input({ resume: {
    ...resume, invocationAttempt: activeCoreSkillCall(fixture.ledger).activationCount,
  } }).context.messages;
  const carrier = (input: readonly ChatMessage[]) => JSON.parse(input.find((message) =>
    message.content.includes('"kind":"runtime_request_tool_results_v1"'))!.content);
  const before = carrier(messages);
  const outcome = await controller(fixture).getStages()[0]!.prepare(messages);
  if (outcome.kind !== "prepared") throw new Error("expected_compaction");
  outcome.preparation.commit();
  const after = carrier(outcome.preparation.messages);
  expect(after.results).toEqual(before.results);
  expect(after.semanticCheckpoint.coveredSources).toEqual(expect.arrayContaining([
    expect.objectContaining({ sourceRef: "core-skill-read:skill-read-1:personal-guidance" }),
  ]));
  expect(capsules(outcome.preparation.messages)).toEqual([]);
  expect(JSON.stringify(after.semanticCheckpoint)).toContain(COMPACTION_FACT);
  expect(JSON.stringify(outcome.preparation.messages)).not.toContain(CORE_SKILL_PADDING);
  expect(skillActions(outcome.preparation.messages)).toEqual(skillActions(messages));
  expect(() => assertSuperCompactionCheckpointIntegrity({
    requestId: fixture.request.requestId, prompt: fixture.request.prompt,
    head: fixture.ledger.current(), store: fixture.store,
    checkpoint: captureRequestContextCompaction(fixture.store).checkpoints[0]!,
  })).not.toThrow();
});

test.each(["standard", "target_only"] as const)(
  "RAW %s context preserves its scope while handing off a captured Skill body without objective copying",
  async (contextScope) => {
    const fixture = await createCoreSkillContextFixture();
    await fixture.read();
    const call = await fixture.open("worker");
    const head = fixture.ledger.current();
    const authoringObjective = "Edit the requested text, preserving its current content.";
    const result = await createRequestWorkerCapabilityPayloadAuthor(fixture.request).author({
      call, authoringObjective, executionId: "capability-execution-1", contextScope,
      assignmentProvenance: projectWorkerCapabilityPayloadSourceProvenance({ ledger: fixture.ledger, head, call }),
      descriptor: {
        capabilityId: "fixture.update", summary: "Update the requested text.", effect: "mutation",
        requiresPayloadAuthoringObjective: true,
        controls: { type: "object", additionalProperties: false, properties: {}, required: [] },
      },
      controls: {}, settledCapabilityResults: bindSuperWorkerCompactionSources([], head, call.callId),
      contract: { instructions: "Return the complete updated text.", minBytes: 1, maxBytes: 4_096 },
      ...(contextScope === "target_only" ? {
        stage: { index: 1, count: 1, outputParam: "content", contextScope },
        targetContext: { targetParam: "path", targetPath: "result.txt", presentation: "full" as const,
          content: "Exact current target content." },
      } : {}),
    });
    expect(result).toMatchObject({ status: "authored" });
    const messages = fixture.modelInputs.find((input) => input.step === "tool_payload.raw")!.messages;
    expect(capsules(messages)).toEqual(contextScope === "standard"
      ? buildCoreSkillReadContextMessages(head, "delegate") : []);
    const prefix = "Canonical runtime context:\n";
    const canonical = JSON.parse(messages.find((message) => message.content.startsWith(prefix))!.content.slice(prefix.length));
    expect(canonical.acceptedCapability.authoringObjective).toBe(authoringObjective);
    expect(canonical).not.toHaveProperty("coreSkillReads");
  },
);

test.each(["supervisor", "planner", "worker"] as const)(
  "%s compacts captured Skill guidance and validates serialized restore against the ledger",
  async (role) => {
    const fixture = await createCoreSkillContextFixture();
    await fixture.read();
    if (role !== "supervisor") await fixture.open(role);
    const input = fixture.input();
    const compaction = controller(fixture);
    const outcome = await compaction.getStages()[0]!.prepare(input.context.messages);
    expect(outcome.kind).toBe("prepared");
    if (outcome.kind !== "prepared") throw new Error("expected_compaction");
    outcome.preparation.commit();
    expect(JSON.stringify(outcome.preparation.messages)).toContain(COMPACTION_FACT);
    expect(JSON.stringify(outcome.preparation.messages)).not.toContain(CORE_SKILL_PADDING);
    const snapshot = captureRequestContextCompaction(fixture.store);
    expect(snapshot.sources.map((source) => source.sourceRef)).toEqual(["core-skill-read:skill-read-1:personal-guidance"]);
    expect(JSON.stringify(snapshot.sources)).toContain(CORE_SKILL_PADDING);
    const integrity = {
      requestId: fixture.request.requestId, prompt: fixture.request.prompt,
      head: fixture.ledger.current(), store: fixture.store,
    };
    expect(() => assertSuperCompactionSourceIntegrity(integrity)).not.toThrow();
    expect(() => assertSuperCompactionCheckpointIntegrity({ ...integrity, checkpoint: snapshot.checkpoints[0]! })).not.toThrow();

    if (role !== "worker") await fixture.open("worker");
    const worker = activeCoreSkillCall(fixture.ledger);
    await commitSkillFixture(fixture.ledger, {
      authority: "active_role", type: "begin_capability_execution", callId: worker.callId,
      invocationAttempt: worker.activationCount, capabilityId: "fixture.save", declaredEffect: "mutation",
      intent: "Save the requested result.", controlsJson: "{}",
    });
    const restoreInput = {
      ledgerCheckpoint: JSON.parse(JSON.stringify(captureRoleCallLedgerCheckpoint(fixture.ledger))),
      requestId: fixture.request.requestId, prompt: fixture.request.prompt,
      executionPolicy: fixture.request.executionPolicy,
    };
    const callsBeforeRestore = fixture.invoke.mock.calls.length;
    const restored = restoreApprovalCompaction({ ...restoreInput, snapshot: JSON.parse(JSON.stringify(snapshot)) });
    expect(restored.snapshot!()).toEqual(snapshot);
    expect(fixture.invoke.mock.calls).toHaveLength(callsBeforeRestore);

    const originalSource = snapshot.sources[0]!;
    const content = originalSource.content.replace(CORE_SKILL_DOCUMENT.content.split("\n")[0]!, "Forged method.");
    const sourceFingerprint = hash(content);
    const changed = {
      ...snapshot, sources: [{ ...originalSource, content, sourceFingerprint }],
      checkpoints: snapshot.checkpoints.map((checkpoint) => ({ ...checkpoint,
        sourceDigests: checkpoint.sourceDigests.map((digest) => ({ ...digest, sourceFingerprint })),
      })),
    };
    expect(() => restoreApprovalCompaction({ ...restoreInput, snapshot: changed }))
      .toThrow("context_compaction_snapshot_source_incompatible");
    expect(fixture.store.snapshot!()).toEqual(snapshot);
    expect(fixture.invoke.mock.calls).toHaveLength(callsBeforeRestore);
  },
);
