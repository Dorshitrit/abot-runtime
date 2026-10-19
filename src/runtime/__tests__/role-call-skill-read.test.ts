import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import {
  createRoleCallLedger, ROLE_CALL_OBJECTIVE_MAX_LENGTH, ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH, SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
  type RoleCallLedger, type RoleCallPolicy,
} from "../orchestration/role-calls/index.js";
import {
  captureRoleCallLedgerCheckpoint, restoreRoleCallLedgerCheckpoint,
} from "../orchestration/role-calls/checkpoint.js";
import { validateRoleSkillReads } from "../orchestration/role-calls/skill-read.js";

const document = {
  skillId: "personal-test", name: "Development", description: "Project conventions.",
  content: "Preserve the requested behavior.\n", source: "personal" as const, revision: 3,
};
const limits: RoleCallPolicy["limits"] = {
  maxDepth: 2, maxCalls: 3, maxCapabilityExecutions: 2,
  maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH, maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
};
const policy: RoleCallPolicy = { authority: SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT, limits };

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

async function commit(ledger: RoleCallLedger, command: unknown) {
  const result = await ledger.apply({ expectedHead: ledger.current(), command });
  expect(result).toMatchObject({ ok: true, status: "committed" });
  if (!result.ok) throw new Error(result.code);
  return result;
}

async function createRoot(selectedPolicy = policy) {
  const ledger = createRoleCallLedger({ requestId: "skill-read-request", policy: selectedPolicy });
  await commit(ledger, { authority: "runtime", type: "create_root" });
  return ledger;
}

function readCommand(invocationAttempt = 1) {
  return {
    authority: "runtime", type: "record_skill_read", callId: "call-1",
    invocationAttempt, steeringVersion: 0, operation: "read_skills",
    selectors: ["personal-test"],
    result: { outcome: "completed", skills: [{ ...document }] },
  };
}

async function parkWorker(ledger: RoleCallLedger) {
  await commit(ledger, {
    authority: "active_role", type: "open_child", callerCallId: "call-1",
    roleId: "worker", objective: "Read the requested file.",
  });
  await commit(ledger, {
    authority: "active_role", type: "begin_capability_execution", callId: "call-2",
    invocationAttempt: 1, capabilityId: "files.read", declaredEffect: "observation",
    intent: "Read the requested file.", controlsJson: "{}",
  });
}

describe("atomic core Skill-read receipts", () => {
  test("captures immutable exact documents without creating capabilities or children", async () => {
    const ledger = await createRoot();
    const before = ledger.current();
    expect(before.state.skillReads).toBeUndefined();
    const command = readCommand();
    const result = await commit(ledger, command);
    command.result.skills[0]!.content = "Changed later.";
    command.result.skills[0]!.revision = 4;
    expect(result.effect).toEqual({
      type: "skill_read_recorded", readId: "skill-read-1", callId: "call-1",
      invocationAttempt: 1, steeringVersion: 0, operation: "read_skills",
    });
    expect(result.head.state.calls[0]).toMatchObject({ status: "active", activationCount: 2 });
    expect(result.head.state.skillReads?.[0]?.result.skills).toEqual([document]);
    expect(Object.isFrozen(result.head.state.skillReads?.[0]?.result.skills[0])).toBe(true);
    expect(result.head.state.capabilityExecutions).toEqual([]);
    expect(result.head.state.calls).toHaveLength(1);
    expect(result.head.state.operationSupervision).toBe(before.state.operationSupervision);
    expect(result.head.state.capabilitySelectionSupervision).toBe(before.state.capabilitySelectionSupervision);
    expect(before.state.skillReads).toBeUndefined();
    expect(before.state.calls[0]?.activationCount).toBe(1);
  });

  test("records LIST metadata and explicit read failure in the same atomic lifecycle", async () => {
    const ledger = await createRoot();
    const { content: _content, revision: _revision, ...metadata } = document;
    await commit(ledger, {
      ...readCommand(), operation: "list_skills", selectors: [],
      result: { outcome: "completed", skills: [metadata] },
    });
    await commit(ledger, {
      ...readCommand(2), selectors: ["missing"],
      result: { outcome: "failed", errorCode: "knowledge_skill_not_found", skills: [] },
    });
    expect(ledger.current().state.skillReads?.map(({ readId, result }) => [readId, result.outcome]))
      .toEqual([["skill-read-1", "completed"], ["skill-read-2", "failed"]]);
    expect(ledger.current().state.calls[0]?.activationCount).toBe(3);
  });

  test("uses the existing activation budget without consuming a Worker call slot", async () => {
    const ledger = await createRoot({ ...policy, limits: { ...limits, maxCalls: 1, maxCapabilityExecutions: 1 } });
    await commit(ledger, readCommand(1));
    await commit(ledger, readCommand(2));
    const before = ledger.current();
    expect(await ledger.apply({ expectedHead: before, command: readCommand(3) }))
      .toMatchObject({ ok: false, code: "role_activation_limit_exceeded", head: before });
    expect(ledger.current()).toBe(before);
    expect(before.state.skillReads).toHaveLength(2);
    expect(before.state.calls).toHaveLength(1);
  });

  test("rejects stale activations, stale heads, Worker callers and EA roots", async () => {
    const ledger = await createRoot();
    const before = ledger.current();
    await commit(ledger, readCommand());
    expect(await ledger.apply({ expectedHead: before, command: readCommand() }))
      .toMatchObject({ ok: false, code: "stale_head" });
    expect(await ledger.apply({ expectedHead: ledger.current(), command: readCommand() }))
      .toMatchObject({ ok: false, code: "skill_read_invocation_mismatch" });
    await commit(ledger, {
      authority: "active_role", type: "open_child", callerCallId: "call-1",
      roleId: "worker", objective: "Perform the delegated work.",
    });
    expect(await ledger.apply({
      expectedHead: ledger.current(), command: { ...readCommand(), callId: "call-2" },
    })).toMatchObject({ ok: false, code: "skill_read_caller_invalid" });
    const direct = await createRoot({
      ...policy, authority: {
        ...policy.authority, id: "execution-agent-v1", rootContractId: "execution_agent",
        capabilityAuthorities: ["root"],
      },
    });
    expect(await direct.apply({ expectedHead: direct.current(), command: readCommand() }))
      .toMatchObject({ ok: false, code: "skill_read_caller_invalid" });
  });

  test.each([
    { selectors: [] },
    { selectors: Array.from({ length: 9 }, (_, index) => String(index)) },
    { selectors: ["other"] },
    { result: { outcome: "completed", skills: [] } },
    { result: { outcome: "completed", skills: [{ ...document, content: "" }] } },
    { result: { outcome: "completed", skills: [{ ...document, content: "א".repeat(32769) }] } },
    { result: { outcome: "completed", skills: [{ ...document, unexpected: true }] } },
    { result: { outcome: "failed", errorCode: "knowledge_skill_not_found", skills: [document] } },
    { operation: "list_skills", selectors: [], result: { outcome: "completed", skills: [document] } },
  ])("rejects malformed or mismatched snapshots: %j", async (changes) => {
    const ledger = await createRoot();
    const before = ledger.current();
    expect(await ledger.apply({ expectedHead: before, command: { ...readCommand(), ...changes } }))
      .toMatchObject({ ok: false, code: "invalid_command" });
    expect(ledger.current()).toBe(before);
  });

  test("retains complete multi-read snapshots and system content beyond personal limits", async () => {
    const ledger = await createRoot();
    const skills = Array.from({ length: 8 }, (_, index) => ({
      skillId: `system-${index}`, name: "Shared name", description: "Packaged guidance.",
      content: "x".repeat(70_000), source: "system",
    }));
    await commit(ledger, { ...readCommand(), selectors: ["Shared name"], result: { outcome: "completed", skills } });
    expect(ledger.current().state.skillReads?.[0]?.result.skills).toEqual(skills);
  });

  test("restores exact snapshots and also accepts older parked heads without the optional field", async () => {
    const older = await createRoot();
    await parkWorker(older);
    const oldCheckpoint = captureRoleCallLedgerCheckpoint(older);
    expect(oldCheckpoint.state.skillReads).toBeUndefined();
    expect(restoreRoleCallLedgerCheckpoint(oldCheckpoint, {
      requestId: "skill-read-request", policy,
    }).current().state.skillReads).toBeUndefined();

    const ledger = await createRoot();
    await commit(ledger, readCommand());
    await parkWorker(ledger);
    const checkpoint = structuredClone(captureRoleCallLedgerCheckpoint(ledger));
    const restored = restoreRoleCallLedgerCheckpoint(checkpoint, {
      requestId: "skill-read-request", policy,
    });
    expect(restored.current().state.skillReads?.[0]?.result.skills).toEqual([document]);
    const invalidReceipt = { ...restored.current().state.skillReads![0]!, readId: "skill-read-2" };
    expect(validateRoleSkillReads({
      ...restored.current().state, skillReads: [invalidReceipt],
    }, policy)).toEqual([{ code: "invalid_role_skill_reads", path: "state.skillReads" }]);
    expect(() => restoreRoleCallLedgerCheckpoint({
      ...checkpoint, revision: checkpoint.revision - 1,
    }, { requestId: "skill-read-request", policy })).toThrow("role_call_checkpoint_revision_inconsistent");
  });
});
