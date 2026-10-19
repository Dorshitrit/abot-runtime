import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createRoleCallLedger, SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
  type ExecutionPolicyAuthoritySnapshot, type RoleCallLedger } from "../orchestration/role-calls/index.js";
import { createRoleCapabilityBinding, EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
  type WorkerCapabilityAdapter, type WorkerCapabilityPreparedExecution } from "../orchestration/worker-capabilities/index.js";
import { restoreCapabilityApprovalGroup } from "../orchestration/worker-capabilities/execution/approval-group.js";
import type { PreparedApprovalGroup } from "../orchestration/worker-capabilities/approval-contracts.js";
import { projectSupervisorWorkerCapabilityDescriptors } from "../orchestration/worker-capabilities/supervisor-skill-authority.js";
import { resolveRequestExecutionPolicy } from "../request/role-executor-composition.js";

const EA_AUTHORITY = resolveRequestExecutionPolicy("execution-agent-v1").authority;
const ACTION_FINGERPRINT = `sha256:${"b".repeat(64)}`;
const capabilityIds = ["create_skill", "update_skill", "list_skills", "read_skill", "read_skills", "write_file"] as const;
beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

async function openCall(role: "root" | "worker", authority: ExecutionPolicyAuthoritySnapshot = SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT) {
  const ledger = createRoleCallLedger({ requestId: "skill-authority", policy: { authority,
    limits: { maxDepth: 4, maxCalls: 8, maxCapabilityExecutions: 16,
      maxObjectiveChars: 8192, maxResultChars: 8192, maxResponseChars: 65536 } } });
  await commit(ledger, { authority: "runtime", type: "create_root" });
  if (role === "worker") await commit(ledger, { authority: "active_role", type: "open_child",
    callerCallId: ledger.current().state.rootCallId, roleId: "worker", objective: "Perform the requested task." });
  const call = ledger.current().state.calls.find(({ callId }) => callId === ledger.current().state.activeCallId)!;
  return { ledger, call };
}

async function commit(ledger: RoleCallLedger, command: unknown) {
  const result = await ledger.apply({ expectedHead: ledger.current(), command });
  if (!result.ok) throw new Error(result.code);
  return result.head;
}

function createAdapter(capabilityId: string) {
  const effect = ["create_skill", "update_skill", "write_file"].includes(capabilityId)
    ? "mutation" as const : "observation" as const;
  const execute = vi.fn(async () => ({ outcome: "succeeded" as const, observedEffect: effect, summary: "Completed.",
    exactResult: { kind: "generic_capability_result_v1" as const, authority: "capability_adapter" as const,
      status: "executed" as const, ok: true, payload: { capabilityId } } }));
  const restore = vi.fn(async (): Promise<WorkerCapabilityPreparedExecution> => ({
    actionFingerprint: ACTION_FINGERPRINT, acceptedControls: {}, snapshot: { capabilityId }, execute,
  }));
  const adapter: WorkerCapabilityAdapter<object> = { descriptor: {
    capabilityId, summary: "Perform the selected operation.", effect, catalogGroups: ["knowledge"],
    controls: EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA }, execute, restore };
  return { adapter, execute, restore };
}

test("SUPER Worker catalog matches execution and other policy authorities remain unchanged", async () => {
  const descriptors = capabilityIds.map((id) => createAdapter(id).adapter.descriptor);
  const worker = await openCall("worker");
  const projected = projectSupervisorWorkerCapabilityDescriptors({ authority: worker.ledger.current().policy.authority, descriptors });
  const binding = createRoleCapabilityBinding({ requestId: "skill-authority", ...worker,
    context: {}, adapters: capabilityIds.map((id) => createAdapter(id).adapter) });
  expect(projected.map(({ capabilityId }) => capabilityId)).toEqual(["list_skills", "read_skill", "read_skills", "write_file"]);
  expect(projected.map(({ capabilityId }) => capabilityId))
    .toEqual(binding.capabilities.map(({ capabilityId }) => capabilityId));
  expect(projectSupervisorWorkerCapabilityDescriptors({ authority: EA_AUTHORITY, descriptors })).toBe(descriptors);
  expect(projectSupervisorWorkerCapabilityDescriptors({
    authority: { ...SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT, version: 99 }, descriptors,
  })).toBe(descriptors);
});

test.each([
  ["root", ["create_skill", "update_skill"], "create_skill", "write_file"],
  ["worker", ["list_skills", "read_skill", "read_skills", "write_file"], "read_skill", "create_skill"],
] as const)("offers and executes only allowed SUPER %s operations", async (role, expected, allowed, denied) => {
  const { ledger, call } = await openCall(role);
  const fixtures = capabilityIds.map(createAdapter);
  const binding = createRoleCapabilityBinding({ requestId: "skill-authority", ledger, call,
    context: {}, adapters: fixtures.map(({ adapter }) => adapter) });
  expect(binding.capabilities.map(({ capabilityId }) => capabilityId)).toEqual(expected);
  await expect(binding.execute({ capabilityId: denied, intent: "Perform this operation.", controls: {} }))
    .rejects.toThrow("capability_unavailable");
  expect(ledger.current().state.capabilityExecutions).toHaveLength(0);
  expect(fixtures.every(({ execute }) => execute.mock.calls.length === 0)).toBe(true);
  await binding.execute({ capabilityId: allowed, intent: "Perform this operation.", controls: {} });
  expect(ledger.current().state.capabilityExecutions[0]).toMatchObject({ capabilityId: allowed, outcome: "succeeded" });
  expect(fixtures.find(({ adapter }) => adapter.descriptor.capabilityId === allowed)!.execute).toHaveBeenCalledOnce();
});

test("EA retains ordinary Skill writes and the rest of its capability catalog", async () => {
  const { ledger, call } = await openCall("root", EA_AUTHORITY);
  const fixtures = capabilityIds.map(createAdapter);
  const binding = createRoleCapabilityBinding({ requestId: "skill-authority", ledger, call,
    context: {}, adapters: fixtures.map(({ adapter }) => adapter) });
  expect(binding.capabilities.map(({ capabilityId }) => capabilityId)).toEqual(capabilityIds);
  await binding.execute({ capabilityId: "create_skill", intent: "Save the requested Skill.", controls: {} });
  expect(ledger.current().state.capabilityExecutions[0]).toMatchObject({ capabilityId: "create_skill", outcome: "succeeded" });
});

test.each([
  ["root", "write_file", false, false],
  ["worker", "create_skill", false, false],
  ["worker", "update_skill", false, false],
  ["root", "create_skill", true, false],
  ["worker", "list_skills", true, false],
  ["root", "write_file", true, true],
] as const)("approval restore preserves %s/%s ownership (allowed=%s, EA=%s)", async (role, capabilityId, allowed, ea) => {
  const { ledger, call } = await openCall(role, ea ? EA_AUTHORITY : SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT);
  const fixture = createAdapter(capabilityId);
  await commit(ledger, { authority: "active_role", type: "begin_capability_execution", callId: call.callId,
    invocationAttempt: call.activationCount, capabilityId, declaredEffect: fixture.adapter.descriptor.effect,
    intent: "Perform this operation.", controlsJson: "{}", actionFingerprint: ACTION_FINGERPRINT });
  const execution = ledger.current().state.capabilityExecutions[0]!;
  const group: PreparedApprovalGroup = { kind: "prepared_approval_group_v1", requestId: "skill-authority",
    callId: call.callId, invocationAttempt: call.activationCount, batch: false,
    entries: [{ executionId: execution.executionId, capabilityId, declaredEffect: fixture.adapter.descriptor.effect,
      intent: execution.intent, controls: {}, actionFingerprint: ACTION_FINGERPRINT, snapshot: { capabilityId } }] };
  const restoration = restoreCapabilityApprovalGroup({ ledger, group, context: {}, adapters: [fixture.adapter] });
  if (!allowed) {
    await expect(restoration).rejects.toThrow("prepared_approval_execution_mismatch");
    expect(fixture.restore).not.toHaveBeenCalled();
    expect(fixture.execute).not.toHaveBeenCalled();
    return;
  }
  const restored = await restoration;
  expect(fixture.restore).toHaveBeenCalledOnce();
  expect(fixture.execute).not.toHaveBeenCalled();
  await restored.execute([]);
  expect(fixture.execute).toHaveBeenCalledOnce();
  expect(ledger.current().state.capabilityExecutions[0]).toMatchObject({ status: "settled", outcome: "succeeded" });
});
