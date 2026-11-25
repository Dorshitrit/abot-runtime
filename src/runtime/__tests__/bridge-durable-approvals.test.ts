import { afterEach, expect, test, vi } from "vitest";
import { successResult } from "../../plugin-sdk/index.js";
import type { LocalPendingToolApproval } from "../local-host/request-approval-contracts.js";
import { resetDebugLoggerConfig } from "../observability/debug-logger.js";
import {
  createBridgeApprovalFixture,
  type BridgeApprovalFrame,
} from "./support/bridge-durable-approval-fixture.js";
import { createSchedulerTestGate } from "./support/scheduler-runtime-fixture.js";

type Fixture = Awaited<ReturnType<typeof createBridgeApprovalFixture>>;
type PendingApproval = Pick<LocalPendingToolApproval, "request" | "wait">;
const scope = { sessionId: "session", requestId: "bridge-saved-request" };
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  resetDebugLoggerConfig();
});

async function fixture(options?: Parameters<typeof createBridgeApprovalFixture>[0]) {
  const current = await createBridgeApprovalFixture(options);
  cleanup.push(current.dispose);
  return current;
}

function runRequest(f: Fixture, requestId = scope.requestId) {
  f.send({
    type: "run_request",
    ...scope,
    requestId,
    text: "Perform the exact fixture effect.",
    approvalMode: "durable_v1",
    toolPermissionMode: "ask",
    agentMode: "reasoning",
    modelPreference: { profileId: "scheduled-model", scope: "all" },
  });
}

function listApprovals(f: Fixture, target = scope) {
  return f.command({ type: "request.approvals.request", ...target });
}

async function parkApprovals(f: Fixture, count = 1): Promise<PendingApproval[]> {
  runRequest(f);
  let pending: PendingApproval[] = [];
  await vi.waitFor(async () => {
    const response = await listApprovals(f);
    expect(response.ok).toBe(true);
    expect(response.finalState, JSON.stringify({
      response,
      failures: f.frames.filter((frame) => frame.type === "event" && frame.error),
    })).toBeNull();
    pending = response.approvals as PendingApproval[];
    expect(pending).toHaveLength(count);
    expect(pending[0]!.wait).toBeDefined();
    expect(f.owner.isIdle?.()).toBe(true);
  }, { timeout: 5000, interval: 20 });
  expect(f.execute).not.toHaveBeenCalled();
  return pending;
}

function approvalDecision(approval: PendingApproval) {
  return {
    type: "request.approval.decide.request",
    ...scope,
    approvalId: approval.request.approvalId,
    ...(approval.wait
      ? { ...approval.wait, commandId: "approve-exact-saved-action" }
      : {}),
    approved: true,
  };
}

function expectDecisionRefused(response: BridgeApprovalFrame) {
  if (response.ok === false) return;
  expect(response.ok).toBe(true);
  expect(response.result).toMatchObject({ accepted: false });
}

test("saved Bridge approval survives both Bridge and managed-owner restart, then resumes once", async () => {
  const f = await fixture();
  const registration = f.frames.find((frame) => frame.type === "register");
  expect(registration?.features).toContain("request_approvals_v1");
  const [pending] = await parkApprovals(f);
  const modelCallsBeforeRestart = f.model.invoke.mock.calls.length;
  const saved = await listApprovals(f);
  expect(saved.lifecycle).toMatchObject({ ...scope, status: "awaiting_approval" });
  expect(JSON.stringify(saved)).not.toContain('"continuation"');

  await f.restart();
  const afterBridgeRestart = await listApprovals(f);
  expect(afterBridgeRestart.approvals).toEqual([pending]);
  expect(f.model.invoke).toHaveBeenCalledTimes(modelCallsBeforeRestart);

  await f.restart(true);
  const afterOwnerRestart = await listApprovals(f);
  expect(afterOwnerRestart.approvals).toEqual([pending]);
  expect(afterOwnerRestart.lifecycle).toEqual(saved.lifecycle);
  expect(f.model.invoke).toHaveBeenCalledTimes(modelCallsBeforeRestart);
  expect(f.execute).not.toHaveBeenCalled();

  const eventStart = f.frames.length;
  const decision = approvalDecision(pending!);
  const receipts = await Promise.all([f.command(decision), f.command(decision)]);
  expect(receipts.map((response) => response.result)).toEqual(expect.arrayContaining([
    { accepted: true },
    { accepted: true, duplicate: true },
  ]));
  expect(receipts.every((response) => response.ok === true)).toBe(true);
  await f.waitForFrame((frame) => frame.type === "completed" && frame.requestId === scope.requestId, eventStart);
  await f.owner.whenIdle?.();
  expect(f.execute).toHaveBeenCalledOnce();
  const resumed = f.frames.slice(eventStart).filter((frame) => frame.requestId === scope.requestId);
  expect(resumed.filter((frame) => frame.name === "tool.approval.granted")).toHaveLength(1);
  expect(resumed.filter((frame) => frame.type === "completed")).toHaveLength(1);

  const replay = await f.command({ type: "request.events.request", requestId: scope.requestId, afterSeq: 0 });
  expect(replay).toMatchObject({ ok: true, finalState: { status: "completed" } });
  expect(replay.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "tool.approval.granted" }),
    expect.objectContaining({ type: "completed" }),
  ]));
  expect(await listApprovals(f)).toMatchObject({ ok: true, approvals: [], finalState: { status: "completed" } });
}, 20_000);

test("recovery and decisions stay bound to the exact request, session and saved-wait identity", async () => {
  const f = await fixture();
  const [pending] = await parkApprovals(f);
  const unchanged = await listApprovals(f);
  for (const target of [
    { ...scope, sessionId: "other-session" },
    { ...scope, requestId: "other-request" },
  ]) {
    const response = await listApprovals(f, target);
    expect(response.approvals ?? []).toEqual([]);
    expect(response.lifecycle ?? null).toBeNull();
    expect(response.finalState ?? null).toBeNull();
  }
  const decision = approvalDecision(pending!);
  const staleDecisions: BridgeApprovalFrame[] = [
    { ...decision, sessionId: "other-session" },
    { ...decision, requestId: "other-request" },
    { ...decision, approvalId: "other-approval" },
    { ...decision, generation: "other-generation" },
    { ...decision, waitId: "other-wait" },
    { ...decision, revision: pending!.wait!.revision + 1 },
    { ...decision, generation: undefined },
    { ...decision, commandId: undefined },
  ];
  for (const stale of staleDecisions) expectDecisionRefused(await f.command(stale));
  expect(f.execute).not.toHaveBeenCalled();
  const afterRefusals = await listApprovals(f);
  expect(afterRefusals.approvals).toEqual([pending]);
  expect(afterRefusals.lifecycle).toEqual(unchanged.lifecycle);
  expect(await f.command(decision)).toMatchObject({ ok: true, result: { accepted: true } });
  await f.waitForFrame((frame) => frame.type === "completed" && frame.requestId === scope.requestId);
  await f.owner.whenIdle?.();
  expect(f.execute).toHaveBeenCalledOnce();
}, 20_000);

test("a partially approved group survives restart and dispatches only after its last exact decision", async () => {
  const f = await fixture({ grouped: true });
  const [first, second] = await parkApprovals(f, 2);
  const firstDecision = approvalDecision(first!);
  expect(await f.command(firstDecision)).toMatchObject({ ok: true, result: { accepted: true } });
  const partial = await listApprovals(f);
  const [remaining] = partial.approvals as PendingApproval[];
  expect(partial.approvals).toHaveLength(1);
  expect(remaining!.request.approvalId).toBe(second!.request.approvalId);
  expect(remaining!.wait!.revision).toBeGreaterThan(second!.wait!.revision);
  expect(partial.lifecycle).toMatchObject({ status: "awaiting_approval" });
  expect(f.execute).not.toHaveBeenCalled();
  const modelCallsBeforeRestart = f.model.invoke.mock.calls.length;

  await f.restart(true);
  expect((await listApprovals(f)).approvals).toEqual([remaining]);
  expect(await f.command(firstDecision)).toMatchObject({ ok: true, result: { accepted: true, duplicate: true } });
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.model.invoke).toHaveBeenCalledTimes(modelCallsBeforeRestart);
  const finalDecision = { ...approvalDecision(remaining!), commandId: "approve-second-action" };
  expect(await f.command(finalDecision)).toMatchObject({ ok: true, result: { accepted: true } });
  await f.waitForFrame((frame) => frame.type === "completed" && frame.requestId === scope.requestId);
  await f.owner.whenIdle?.();
  expect(f.execute).toHaveBeenCalledTimes(2);
  expect(await f.command(finalDecision)).toMatchObject({ ok: true, result: { accepted: true, duplicate: true } });
  expect(f.execute).toHaveBeenCalledTimes(2);
}, 20_000);

test("legacy approval recovery rebinds resumed events after only the remote WebSocket is replaced", async () => {
  const f = await fixture();
  f.send({
    type: "run_request", ...scope,
    text: "Perform the exact fixture effect.",
    toolPermissionMode: "ask", agentMode: "reasoning",
    modelPreference: { profileId: "scheduled-model", scope: "all" },
  });
  await f.waitForFrame((frame) => frame.name === "tool.approval.required");
  const callsBeforeReconnect = f.model.invoke.mock.calls.length;
  expect(f.owner.isIdle?.()).toBe(false);
  await f.replaceRemoteSocket();
  const recovered = await listApprovals(f);
  expect(recovered.ok).toBe(true);
  const approvals = recovered.approvals as PendingApproval[];
  expect(approvals).toHaveLength(1);
  expect(approvals[0]!.wait).toBeUndefined();
  expect(f.model.invoke).toHaveBeenCalledTimes(callsBeforeReconnect);
  const after = f.frames.length;
  expect(await f.command({
    type: "request.approval.decide.request", ...scope,
    approvalId: approvals[0]!.request.approvalId, approved: true,
  })).toMatchObject({ ok: true, result: { accepted: true } });
  await f.waitForFrame((frame) => frame.type === "completed" && frame.requestId === scope.requestId, after);
  await f.owner.whenIdle?.();
  expect(f.execute).toHaveBeenCalledOnce();
  expect(f.frames.slice(after).filter((frame) => frame.type === "completed")).toHaveLength(1);
}, 10_000);

test("local pause, forget and replacement preserve a live remote approval and its usable connection", async () => {
  const f = await fixture({ managedTransport: true });
  f.send({
    type: "run_request", ...scope, text: "Perform the exact fixture effect.",
    toolPermissionMode: "ask", agentMode: "reasoning",
    modelPreference: { profileId: "scheduled-model", scope: "all" },
  });
  const pending = await f.waitForFrame(frame => frame.name === "tool.approval.required");
  const revision = { expectedRevision: 1 };
  await expect(f.management.pause(revision)).rejects.toThrow("socket_connection_busy");
  await expect(f.management.forget(revision)).rejects.toThrow("socket_connection_busy");
  await expect(f.management.import({ bundle: { ...f.bundle, runtimeToken: "y".repeat(43) }, ...revision }))
    .rejects.toThrow("socket_connection_busy");
  expect(await f.management.status()).toMatchObject({ state: "connected", revision: 1 });
  expect(f.execute).not.toHaveBeenCalled();
  f.send({ type: "tool_approval_response", approvalId: pending.approvalId, approved: true });
  await f.waitForFrame(frame => frame.type === "completed" && frame.requestId === scope.requestId);
  await f.owner.whenIdle?.();
  expect(f.execute).toHaveBeenCalledOnce();
  expect(await f.management.pause(revision)).toMatchObject({ state: "paused", revision: 2 });
}, 10_000);

test("a parked approval survives an explicit local pause and resume, and remains decidable exactly once", async () => {
  const f = await fixture({ managedTransport: true });
  const [approval] = await parkApprovals(f);
  const calls = f.model.invoke.mock.calls.length;
  expect(await f.management.pause({ expectedRevision: 1 })).toMatchObject({ state: "paused", revision: 2 });
  await f.management.resume({ expectedRevision: 2 });
  await vi.waitFor(async () => expect((await f.management.status()).state).toBe("connected"));
  expect(await listApprovals(f)).toMatchObject({ ok: true, approvals: [approval] });
  expect(f.model.invoke).toHaveBeenCalledTimes(calls);
  expect(f.execute).not.toHaveBeenCalled();
  expect(await f.command(approvalDecision(approval!))).toMatchObject({ ok: true, result: { accepted: true } });
  await f.waitForFrame(frame => frame.type === "completed" && frame.requestId === scope.requestId);
  expect(f.execute).toHaveBeenCalledOnce();
}, 10_000);

test("a handler without approval controls refuses durable mode instead of silently using legacy approval", async () => {
  const f = await fixture({ legacyHandler: true });
  const registration = f.frames.find((frame) => frame.type === "register");
  expect(registration?.features ?? []).not.toContain("request_approvals_v1");
  const after = f.frames.length;
  runRequest(f, "unsupported-durable-request");
  const failure = await f.waitForFrame(
    (frame) => frame.type === "failed" && frame.requestId === "unsupported-durable-request",
    after,
  );
  expect(failure.error).toBeTypeOf("string");
  expect(f.model.invoke).not.toHaveBeenCalled();
  expect(f.execute).not.toHaveBeenCalled();
  expect(await listApprovals(f)).toMatchObject({ ok: false });

  f.send({
    type: "run_request",
    ...scope,
    requestId: "legacy-after-refusal",
    text: "Perform the exact fixture effect.",
    toolPermissionMode: "ask",
    agentMode: "reasoning",
    modelPreference: { profileId: "scheduled-model", scope: "all" },
  });
  const liveApproval = await f.waitForFrame(
    (frame) => frame.name === "tool.approval.required" && frame.requestId === "legacy-after-refusal",
    after,
  );
  expect(f.owner.isIdle?.()).toBe(false);
  f.send({ type: "tool_approval_response", approvalId: liveApproval.approvalId, approved: true });
  await f.waitForFrame((frame) => frame.type === "completed" && frame.requestId === "legacy-after-refusal", after);
  await f.owner.whenIdle?.();
  expect(f.execute).toHaveBeenCalledOnce();
}, 10_000);

test("retrying a lost decision reply on a replacement socket restores delivery without repeating the running action", async () => {
  const f = await fixture();
  const effect = createSchedulerTestGate();
  f.execute.mockImplementationOnce(async () => {
    await effect.waiting;
    return successResult({ output: "The gated fixture effect completed." });
  });
  try {
    const [pending] = await parkApprovals(f);
    const decision = approvalDecision(pending!);
    const lostCorrelationId = await f.sendLosingReply(decision);
    expect(f.frames.some((frame) => frame.correlationId === lostCorrelationId)).toBe(false);
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
    expect(f.owner.isIdle?.()).toBe(false);
    await f.replaceRemoteSocket();
    const after = f.frames.length;
    expect(await f.command(decision)).toMatchObject({
      ok: true, result: { accepted: true, duplicate: true },
    });
    expect(f.execute).toHaveBeenCalledOnce();
    effect.open();
    await f.waitForFrame((frame) => frame.type === "completed" && frame.requestId === scope.requestId, after);
    await f.owner.whenIdle?.();
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.frames.slice(after).filter((frame) => frame.type === "completed")).toHaveLength(1);
  } finally {
    effect.open();
  }
}, 15_000);

test.each(["durable", "legacy"] as const)("%s Bridge requests preserve whitespace in the request identity through approval and completion", async (mode) => {
  const f = await fixture();
  const target = { ...scope, requestId: "  bridge-whitespace-request  " };
  f.send({
    type: "run_request", ...target,
    text: "Perform the exact fixture effect.",
    ...(mode === "durable" ? { approvalMode: "durable_v1" } : {}),
    toolPermissionMode: "ask", agentMode: "reasoning",
    modelPreference: { profileId: "scheduled-model", scope: "all" },
  });
  await f.waitForFrame((frame) => frame.name === "tool.approval.required" && frame.requestId === target.requestId);
  let pending: PendingApproval | undefined;
  await vi.waitFor(async () => {
    const response = await listApprovals(f, target);
    expect(response.ok).toBe(true);
    const approvals = response.approvals as PendingApproval[];
    expect(approvals).toHaveLength(1);
    pending = approvals[0];
    expect(pending!.request.requestId).toBe(target.requestId);
    expect(Boolean(pending!.wait)).toBe(mode === "durable");
  }, { timeout: 5000, interval: 20 });
  expect(await f.command({ ...approvalDecision(pending!), ...target })).toMatchObject({
    ok: true, result: { accepted: true },
  });
  await f.waitForFrame((frame) => frame.type === "completed" && frame.requestId === target.requestId);
  await f.owner.whenIdle?.();
  expect(f.execute).toHaveBeenCalledOnce();
  expect(f.frames.filter((frame) => frame.requestId === target.requestId.trim())).toEqual([]);
}, 15_000);

test.each(["recover", "decide"] as const)("%s reconnects the managed client to its live owner before reading a saved approval", async (firstCommand) => {
  const f = await fixture();
  const [pending] = await parkApprovals(f);
  const owner = f.owner;
  const modelCallsBeforeLoss = f.model.invoke.mock.calls.length;
  await f.disconnectLocalRpc();
  expect(owner.isIdle?.()).toBe(true);
  if (firstCommand === "recover") {
    expect(await listApprovals(f)).toMatchObject({ ok: true, approvals: [pending] });
  }
  expect(f.model.invoke).toHaveBeenCalledTimes(modelCallsBeforeLoss);
  const after = f.frames.length;
  expect(await f.command(approvalDecision(pending!))).toMatchObject({
    ok: true, result: { accepted: true },
  });
  await f.waitForFrame((frame) => frame.type === "completed" && frame.requestId === scope.requestId, after);
  await owner.whenIdle?.();
  expect(f.owner).toBe(owner);
  expect(f.execute).toHaveBeenCalledOnce();
}, 15_000);
