import { afterEach, expect, test, vi } from "vitest";
import { SPARK_SESSION_ID } from "../../sessions/spark-session.js";
import { createLocalRuntimeApplication } from "../local-application.js";
import type { LocalPendingToolApproval } from "../local-host/request-approval-contracts.js";
import { SPARK_CHAT_FEATURE } from "../spark-chat/contracts.js";
import { createBridgeSparkFixture } from "./support/bridge-spark-fixture.js";
import { createBridgeApprovalFixture } from "./support/bridge-durable-approval-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanups.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
});

async function fixture(supported = true) {
  const f = await createBridgeSparkFixture(supported);
  cleanups.push(f.dispose);
  return f;
}

test("registers SPARK support and opens only the canonical chat through actual Bridge transport", async () => {
  const f = await fixture();
  expect(f.frames.find((frame) => frame.type === "register")?.features).toContain(SPARK_CHAT_FEATURE);
  expect(await f.command({ type: "spark.chat.open.request" })).toEqual({
    type: "spark.chat.open.response", correlationId: "spark-query-1", ok: true,
    sessionId: SPARK_SESSION_ID, modelProfileId: "spark", toolPermissionMode: "ask", readiness: "ready",
  });
  expect(await f.sessions.getSessionById(SPARK_SESSION_ID)).toMatchObject({ kind: "spark" });
  expect(f.run).not.toHaveBeenCalled();
});

test.each(["sessionId", "modelProfileId", "toolPermissionMode"])(
  "open refuses caller-selected %s before creating a companion", async (field) => {
    const f = await fixture();
    expect(await f.command({ type: "spark.chat.open.request", [field]: "untrusted" }))
      .toMatchObject({ ok: false, error: "invalid_spark_chat_request" });
    expect(await f.sessions.getSessionById(SPARK_SESSION_ID)).toBeNull();
    expect(f.status).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  },
);

test("dispatches the canonical model and retains normal request controls and identity", async () => {
  const f = await fixture();
  await f.command({ type: "spark.chat.open.request" });
  f.send({
    type: "run_request", requestId: "spark-run", sessionId: SPARK_SESSION_ID,
    text: "Help", toolPermissionMode: "ask", modelPreference: { profileId: "untrusted" },
  });
  await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce());
  expect(f.run).toHaveBeenCalledWith(expect.anything(), {
    type: "run_request", requestId: "spark-run", sessionId: SPARK_SESSION_ID,
    text: "Help", toolPermissionMode: "ask", modelPreference: { profileId: "spark", scope: "all" },
  }, expect.objectContaining({
    toolApprovalController: expect.any(Object), requestSteering: expect.any(Object),
  }));
});

test("rechecks the canonical permission at send and refuses a stale connection grant", async () => {
  const f = await fixture();
  await f.command({ type: "spark.chat.open.request" });
  f.configure({ sparkToolPermissionMode: "full_plus" });
  f.send({
    type: "run_request", requestId: "stale", sessionId: SPARK_SESSION_ID,
    text: "Help", toolPermissionMode: "ask",
  });
  expect(await f.waitForFrame((frame) => frame.requestId === "stale")).toMatchObject({
    type: "failed", sessionId: SPARK_SESSION_ID, error: "spark_chat_permission_mismatch",
  });
  expect(f.run).not.toHaveBeenCalled();
  expect(await f.command({ type: "spark.chat.open.request" })).toMatchObject({ toolPermissionMode: "full_plus" });
  f.send({
    type: "run_request", requestId: "refreshed", sessionId: SPARK_SESSION_ID,
    text: "Help", toolPermissionMode: "full_plus",
  });
  await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce());
  expect(f.run.mock.calls[0]?.[1]).toMatchObject({ requestId: "refreshed", toolPermissionMode: "full_plus" });
});

test("a legacy handler refuses SPARK without changing ordinary request dispatch", async () => {
  const f = await fixture(false);
  expect(f.frames.find((frame) => frame.type === "register")?.features ?? []).not.toContain(SPARK_CHAT_FEATURE);
  expect(await f.command({ type: "spark.chat.open.request" })).toMatchObject({
    type: "spark.chat.open.response", ok: false, error: "spark_chat_unsupported",
  });
  f.send({ type: "run_request", requestId: "unsupported", sessionId: SPARK_SESSION_ID, text: "Hello" });
  expect(await f.waitForFrame((frame) => frame.requestId === "unsupported")).toMatchObject({
    type: "failed", error: "spark_chat_unsupported",
  });
  expect(f.run).not.toHaveBeenCalled();
  const ordinary = {
    type: "run_request", requestId: "ordinary", sessionId: "session", text: "Hello",
    modelPreference: { profileId: "ordinary" }, toolPermissionMode: "full_plus",
  };
  f.send(ordinary);
  await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce());
  expect(f.run.mock.calls[0]?.[1]).toEqual(ordinary);
  expect(f.status).not.toHaveBeenCalled();
});

test.each(["session_busy", "session_awaiting_approval"])(
  "SPARK preserves the bound handler's %s admission failure", async (error) => {
    const f = await fixture();
    await f.command({ type: "spark.chat.open.request" });
    f.run.mockRejectedValueOnce(new Error(error));
    f.send({
      type: "run_request", requestId: "blocked", sessionId: SPARK_SESSION_ID,
      text: "Follow up", toolPermissionMode: "ask",
    });
    expect(await f.waitForFrame((frame) => frame.requestId === "blocked")).toMatchObject({
      type: "failed", sessionId: SPARK_SESSION_ID, error,
    });
    expect(f.run).toHaveBeenCalledOnce();
  },
);

test("returns configuration readiness but never dispatches an unconfigured companion", async () => {
  const f = await fixture();
  f.configure({ proactiveModelProfileId: undefined, modelProfileId: undefined });
  expect(await f.command({ type: "spark.chat.open.request" })).toMatchObject({
    ok: true, readiness: "model_required", modelProfileId: null,
  });
  f.send({
    type: "run_request", requestId: "no-model", sessionId: SPARK_SESSION_ID,
    text: "Help", toolPermissionMode: "ask",
  });
  expect(await f.waitForFrame((frame) => frame.requestId === "no-model")).toMatchObject({
    type: "failed", error: "spark_chat_model_required",
  });
  expect(f.run).not.toHaveBeenCalled();
  f.status.mockRejectedValueOnce(new Error("private local preference path"));
  expect(await f.command({ type: "spark.chat.open.request" })).toMatchObject({
    ok: false, error: "spark_chat_unavailable",
  });
  expect(JSON.stringify(f.frames)).not.toContain("private local preference path");
});

test("managed SPARK uses the existing durable approval recovery across owner restart", async () => {
  const f = await createBridgeApprovalFixture();
  cleanups.push(f.dispose);
  const manager = createLocalRuntimeApplication(f.base.config);
  try {
    await manager.start();
    await manager.services.passiveLearning.configure({ proactiveModelProfileId: "scheduled-model" });
  } finally {
    await manager.stop();
  }
  const opened = await f.command({ type: "spark.chat.open.request" });
  expect(opened).toMatchObject({ ok: true, sessionId: SPARK_SESSION_ID, modelProfileId: "scheduled-model", readiness: "ready" });
  expect(f.model.invoke).not.toHaveBeenCalled();
  const scope = { sessionId: SPARK_SESSION_ID, requestId: "spark-saved-request" };
  f.send({
    type: "run_request", ...scope, text: "Perform the exact fixture effect.",
    approvalMode: "durable_v1", toolPermissionMode: "ask", agentMode: "reasoning",
    modelPreference: { profileId: "ignored-client-model", scope: "all" },
  });
  let pending: LocalPendingToolApproval | undefined;
  await vi.waitFor(async () => {
    const state = await f.command({ type: "request.approvals.request", ...scope });
    expect(state.lifecycle).toMatchObject({ ...scope, status: "awaiting_approval" });
    pending = (state.approvals as LocalPendingToolApproval[])[0];
    expect(pending?.wait).toBeDefined();
  }, { timeout: 5000, interval: 20 });
  const callsBeforeRecovery = f.model.invoke.mock.calls.length;
  await f.restart(true);
  expect(await f.command({ type: "spark.chat.open.request" })).toMatchObject({
    ok: true, sessionId: SPARK_SESSION_ID, modelProfileId: "scheduled-model",
  });
  const recovered = await f.command({ type: "request.approvals.request", ...scope });
  expect(recovered.approvals).toEqual([pending]);
  expect(f.model.invoke).toHaveBeenCalledTimes(callsBeforeRecovery);
  expect(f.execute).not.toHaveBeenCalled();
  const decision = await f.command({
    type: "request.approval.decide.request", ...scope,
    approvalId: pending!.request.approvalId, ...pending!.wait,
    commandId: "spark-approval", approved: true,
  });
  expect(decision).toMatchObject({ ok: true, result: { accepted: true } });
  await f.waitForFrame((frame) => frame.type === "completed" && frame.requestId === scope.requestId);
  expect(f.execute).toHaveBeenCalledOnce();
}, 20_000);
