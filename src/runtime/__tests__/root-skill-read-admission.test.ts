import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createRoleCallLedger, type RoleCallLedger } from "../orchestration/role-calls/index.js";
import { captureRoleCallLedgerCheckpoint, restoreRoleCallLedgerCheckpoint } from "../orchestration/role-calls/checkpoint.js";
import { createRequestExecutionScope } from "../request/execution-scope.js";
import { createRequestRoleCallPolicy } from "../request/role-call-policy.js";
import { performRootSkillRead } from "../request/root-skill-read.js";
import type { KnowledgeSkillDocument } from "../knowledge-skills/store.js";
import type { SkillReadDecision } from "../steps/skill-read-decision.js";
import { resolveKnowledgeSkillReadTargets } from "../capabilities/knowledge-skills/read-targets.js";
import { createMemoryRecallHarness } from "./support/memory-recall-runner.js";

const first: KnowledgeSkillDocument = {
  skillId: "first-guide", name: "First guide", description: "First procedure.",
  content: "Apply the first procedure.",
};
const second: KnowledgeSkillDocument = {
  skillId: "second-guide", name: "Second guide", description: "Second procedure.",
  content: "Apply the second procedure.",
};

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

async function commit(ledger: RoleCallLedger, command: unknown) {
  const result = await ledger.apply({ expectedHead: ledger.current(), command });
  if (!result.ok) throw new Error(result.code);
}

async function fixture() {
  const documents = [first, second];
  const store = {
    list: vi.fn(() => documents.map(({ skillId, name, description }) => ({ skillId, name, description }))),
    read: vi.fn((skillId: string) => documents.find((document) => document.skillId === skillId)),
  };
  const harness = createMemoryRecallHarness({
    policy: "supervisor-worker-v1", enabled: false,
    decide: () => { throw new Error("unexpected_model_call"); },
  });
  const request = createRequestExecutionScope({
    seed: harness.request, executionPolicy: harness.request.executionPolicy,
    knowledgeSkillStore: store,
    createWorkerCapabilities: () => harness.request.workerCapabilities.provider,
  });
  const policy = createRequestRoleCallPolicy(request.executionPolicy);
  const ledger = createRoleCallLedger({ requestId: request.requestId, policy });
  await commit(ledger, { authority: "runtime", type: "create_root" });
  async function record(skills: readonly KnowledgeSkillDocument[], selectors = skills.map(({ skillId }) => skillId)) {
    const head = ledger.current();
    const call = head.state.calls[0]!;
    await commit(ledger, {
      authority: "runtime", type: "record_skill_read", callId: call.callId,
      invocationAttempt: call.activationCount, steeringVersion: 0,
      operation: "read_skills", selectors, result: { outcome: "completed", skills },
    });
  }
  async function invoke(decision: SkillReadDecision, targetLedger = ledger) {
    const head = targetLedger.current();
    const call = head.state.calls.find(({ callId }) => callId === head.state.rootCallId)!;
    return performRootSkillRead({ request, ledger: targetLedger, head, call, steeringVersion: 0, decision });
  }
  const read = (skillIds: readonly string[], targetLedger = ledger) =>
    invoke({ action: "read_skills", skillIds }, targetLedger);
  return { store, request, ledger, policy, record, invoke, read };
}

test.each([
  [first.skillId],
  [second.skillId, first.skillId],
  [first.skillId, second.skillId],
])("rejects the entire repeated-read batch before document access: %j", async (...skillIds) => {
  const f = await fixture();
  await f.record([first]);
  const before = f.ledger.current();
  await expect(f.read(skillIds)).rejects.toThrow("skill_read_already_completed");
  expect(f.store.read).not.toHaveBeenCalled();
  expect(f.store.list).not.toHaveBeenCalled();
  expect(f.ledger.current()).toBe(before);
  expect(f.request.onEvent).not.toHaveBeenCalled();
});

test("rejects duplicate IDs within a new batch before document access", async () => {
  const f = await fixture();
  const before = f.ledger.current();
  await expect(f.read([second.skillId, second.skillId])).rejects.toThrow("skill_read_duplicate_ids");
  expect(f.store.read).not.toHaveBeenCalled();
  expect(f.ledger.current()).toBe(before);
  expect(f.request.onEvent).not.toHaveBeenCalled();
});

test("uses full restored ledger identities beyond 32 entries and preserves historical name and duplicate receipts", async () => {
  const f = await fixture();
  await f.record([first], [first.name]);
  await f.record([first]);
  for (let index = 0; index < 33; index += 1) {
    await f.record([{ ...second, skillId: `historical-${index}`, name: `Historical ${index}` }]);
  }
  await commit(f.ledger, {
    authority: "active_role", type: "open_child", callerCallId: "call-1",
    roleId: "worker", objective: "Read the requested target.",
  });
  await commit(f.ledger, {
    authority: "active_role", type: "begin_capability_execution", callId: "call-2",
    invocationAttempt: 1, capabilityId: "files.read", declaredEffect: "observation",
    intent: "Read the requested target.", controlsJson: "{}",
  });
  const checkpoint = captureRoleCallLedgerCheckpoint(f.ledger);
  const restored = restoreRoleCallLedgerCheckpoint(checkpoint, {
    requestId: f.request.requestId, policy: f.policy,
  });
  await commit(restored, {
    authority: "runtime", type: "settle_capability_execution", callId: "call-2",
    executionId: "capability-execution-1", outcome: "succeeded", observedEffect: "observation",
    summary: "Read the target.", exactResult: {
      kind: "generic_capability_result_v1", authority: "capability_adapter", status: "executed", ok: true,
      payload: { outcome: "succeeded", observedEffect: "observation", summary: "Read the target." },
    },
  });
  await commit(restored, {
    authority: "runtime", type: "return_child", callerCallId: "call-1", childCallId: "call-2",
    outcome: "completed", summary: "The target was read.",
  });
  const before = restored.current();
  expect(before.state.skillReads).toHaveLength(35);
  await expect(f.read([second.skillId, first.skillId], restored)).rejects.toThrow("skill_read_already_completed");
  expect(f.store.read).not.toHaveBeenCalled();
  expect(restored.current()).toBe(before);
  expect(before.state.skillReads?.[0]?.selectors).toEqual([first.name]);
});

test("new canonical IDs commit one exact batch and remain eligible in a fresh request", async () => {
  const f = await fixture();
  await f.read([first.skillId, second.skillId]);
  expect(f.store.read.mock.calls).toEqual([[first.skillId], [second.skillId]]);
  expect(f.store.list).not.toHaveBeenCalled();
  expect(f.ledger.current().state.skillReads).toHaveLength(1);
  expect(f.ledger.current().state.skillReads?.[0]?.result).toEqual({ outcome: "completed", skills: [first, second] });
  const fresh = await fixture();
  await fresh.read([first.skillId]);
  expect(fresh.store.read).toHaveBeenCalledExactlyOnceWith(first.skillId);
});

test("LIST metadata and a failed lookup do not establish a successful document read", async () => {
  const f = await fixture();
  await f.invoke({ action: "list_skills" });
  f.store.read.mockReturnValueOnce(undefined);
  await f.read([first.skillId]);
  expect(f.ledger.current().state.skillReads?.at(-1)?.result).toMatchObject({
    outcome: "failed", errorCode: "knowledge_skill_not_found", skills: [],
  });
  await f.read([first.skillId]);
  expect(f.store.read).toHaveBeenCalledTimes(2);
  expect(f.ledger.current().state.skillReads?.at(-1)?.result).toEqual({ outcome: "completed", skills: [first] });
});

test("root reads exact IDs while the shared public resolver retains full-name support", async () => {
  const f = await fixture();
  await f.read([first.name]);
  expect(f.store.read).toHaveBeenCalledExactlyOnceWith(first.name);
  expect(f.store.list).not.toHaveBeenCalled();
  expect(f.ledger.current().state.skillReads?.at(-1)?.result).toMatchObject({
    outcome: "failed", errorCode: "knowledge_skill_not_found", skills: [],
  });
  f.store.read.mockClear();
  expect(resolveKnowledgeSkillReadTargets(f.store, [first.name])).toEqual({ ok: true, skills: [first] });
  expect(f.store.read.mock.calls).toEqual([[first.name], [first.skillId]]);
});

test("does not accept a Store document returned under a different canonical ID", async () => {
  const f = await fixture();
  f.store.read.mockReturnValueOnce(first);
  await f.read([second.skillId]);
  expect(f.ledger.current().state.skillReads?.at(-1)?.result).toMatchObject({
    outcome: "failed", errorCode: "knowledge_skill_not_found", skills: [],
  });
});
