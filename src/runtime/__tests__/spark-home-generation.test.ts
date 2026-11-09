import { afterEach, expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { createSparkHomeGenerationService } from "../spark-home/generation/service.js";
import type { SparkHomeRunSnapshot } from "../spark-home/generation/contracts.js";
import { createHomeGenerationFixture, homeReadTool, deferred } from "./support/spark-home-generation-fixture.js";
import { disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";

afterEach(disposeCompositionFixtures);
const start = { expectedSettingsRevision: 1 };

test("HOME captures once, carries read evidence through followup to HTML, and only invokes own utility steps", async () => {
  const tool = homeReadTool();
  const f = await createHomeGenerationFixture([tool]);
  f.setPlan({ direction: "Use current source evidence", reads: [{ operation: "web_search:search", purpose: "Current astronomy", controls: { query: "astronomy" } }] });
  let observedPending = false;
  f.service.subscribe(snapshot => { if (snapshot.revision === 1) observedPending = !f.service.isIdle(); });
  const admitted = await f.service.start({ ...start, instruction: "Keep the result in Hebrew." });
  const done = await f.service.wait(admitted.runId);
  expect(done).toMatchObject({ status: "completed", screenRevision: 4 });
  expect(observedPending).toBe(true);
  expect(f.invoke.mock.calls.map(([call]) => call.modelStep)).toEqual(["spark_home.plan", "spark_home.followup", "spark_home.html"]);
  expect(f.context.capture).toHaveBeenCalledTimes(1);
  expect(tool.implementation).toHaveBeenCalledTimes(1);
  const inputs = f.invoke.mock.calls.map(([call]) => call.messages as ChatMessage[]);
  expect(JSON.stringify(inputs[0])).not.toContain("OLD_SCREEN");
  expect(JSON.stringify(inputs[1])).toContain("SOURCE_OBSERVATION_42");
  expect(JSON.stringify(inputs[2])).toContain("SOURCE_OBSERVATION_42");
  expect(JSON.stringify(inputs[2])).toContain("#123456");
  for (const messages of inputs) {
    expect(JSON.parse(messages[1].content)).toMatchObject({ personalInstructions: "Show sourced astronomy news and today's date.", currentInstruction: "Keep the result in Hebrew." });
  }
  expect(f.models.invokeRaw).not.toHaveBeenCalled();
});

test.each(["missing", "super", "override"])("ineligible model %s fails before model calls or screen changes", async kind => {
  const f = await createHomeGenerationFixture();
  if (kind === "missing") delete f.config.models!.profiles!.home;
  if (kind === "super") f.config.modelExecutionPolicies = { home: { policy: "supervisor-worker-v1" } };
  if (kind === "override") f.config.models!.defaults = { profileId: "other", overrideClientPreference: true };
  await expect(f.service.start(start)).rejects.toMatchObject({ code: expect.stringMatching(/^spark_home_/) });
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.update).not.toHaveBeenCalled();
});

test("ASK preserves exact prepared read until one decision; duplicate decisions cannot execute it twice", async () => {
  const tool = homeReadTool();
  const f = await createHomeGenerationFixture([tool]);
  f.setMode("ask");
  f.setPlan({ direction: "Read one source", reads: [{ operation: "web_search:search", purpose: "Research astronomy", controls: { query: "astronomy" } }] });
  const pending = deferred<SparkHomeRunSnapshot>();
  f.service.subscribe(snapshot => { if (snapshot.status === "awaiting_approval") pending.resolve(snapshot); });
  const admitted = await f.service.start(start);
  const approval = await pending.promise;
  expect(tool.implementation).not.toHaveBeenCalled();
  expect(approval.pendingApproval).toMatchObject({ tool: "web_search", summary: "Research astronomy" });
  const decision = { runId: admitted.runId, approvalId: approval.pendingApproval!.approvalId, approved: true };
  await f.service.decideApproval(decision);
  await expect(f.service.decideApproval(decision)).rejects.toMatchObject({ code: "spark_home_approval_not_pending" });
  expect((await f.service.wait(admitted.runId)).status).toBe("completed");
  expect(tool.implementation).toHaveBeenCalledTimes(1);
});

test.each(["cancel", "stop"])("%s during live ASK performs no read and preserves the previous screen", async command => {
  const tool = homeReadTool();
  const f = await createHomeGenerationFixture([tool]);
  f.setMode("ask");
  f.setPlan({ direction: "Read one source", reads: [{ operation: "web_search:search", purpose: "Research", controls: { query: "astronomy" } }] });
  const pending = deferred<void>();
  f.service.subscribe(snapshot => { if (snapshot.status === "awaiting_approval") pending.resolve(); });
  const admitted = await f.service.start(start);
  await pending.promise;
  await expect(f.service.start(start)).rejects.toMatchObject({ code: "spark_home_run_busy" });
  if (command === "cancel") await f.service.cancel({ runId: admitted.runId });
  if (command === "stop") await f.service.stop();
  expect((await f.service.readRun())?.status).toBe(command === "cancel" ? "cancelled" : "interrupted");
  expect(tool.implementation).not.toHaveBeenCalled();
  expect(f.update).not.toHaveBeenCalled();
  expect(f.screen().html).toBe("<p>OLD_SCREEN</p>");
});

test("cancellation during final settings queue wait is checked before publication", async () => {
  const f = await createHomeGenerationFixture();
  const reached = deferred<void>();
  const release = deferred<void>();
  const guard = f.dependencies.settings.withCalibrationReady;
  f.dependencies.settings.withCalibrationReady = async action => { reached.resolve(); await release.promise; return guard(action); };
  const admitted = await f.service.start(start);
  await reached.promise;
  const cancellation = f.service.cancel({ runId: admitted.runId });
  release.resolve();
  expect((await cancellation).status).toBe("cancelled");
  expect(f.update).not.toHaveBeenCalled();
});

test("changed settings prevent a stale generated page replacing the current screen", async () => {
  const f = await createHomeGenerationFixture();
  f.service.subscribe(snapshot => { if (snapshot.phase === "publish") f.changeSettings(); });
  const admitted = await f.service.start(start);
  expect(await f.service.wait(admitted.runId)).toMatchObject({ status: "failed", errorCode: "spark_home_settings_stale" });
  expect(f.update).not.toHaveBeenCalled();
});

test("owner restart interrupts metadata without replaying a model, tool or approval", async () => {
  const f = await createHomeGenerationFixture();
  f.setSaved({ runId: "previous", revision: 3, status: "awaiting_approval", phase: "collect", startedAt: "2026-11-02T00:00:00Z",
    updatedAt: "2026-11-02T00:00:00Z", screenRevision: null, pendingApproval: { approvalId: "old", tool: "web_search", summary: "Old approval" }, errorCode: null });
  const fresh = createSparkHomeGenerationService(f.dependencies);
  expect(await fresh.readRun()).toMatchObject({ runId: "previous", status: "interrupted", pendingApproval: null });
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.update).not.toHaveBeenCalled();
  await expect(fresh.decideApproval({ runId: "previous", approvalId: "old", approved: true })).rejects.toMatchObject({ code: "spark_home_approval_not_pending" });
});

test("the first running notification already exposes the exact pending lifetime to the owner", async () => {
  const f = await createHomeGenerationFixture();
  const release = deferred<void>();
  f.invoke.mockImplementationOnce(async () => { await release.promise; return { text: JSON.stringify({ direction: "Compose page", reads: [] }), meta: {} }; });
  let idleSettled = false;
  let hold: Promise<void> | undefined;
  f.service.subscribe(snapshot => {
    if (snapshot.revision !== 1) return;
    hold = f.service.whenIdle().then(() => { idleSettled = true; });
  });
  const run = await f.service.start(start);
  await Promise.resolve();
  expect(hold).toBeDefined();
  expect(idleSettled).toBe(false);
  release.resolve();
  await f.service.wait(run.runId);
  await hold;
  expect(idleSettled).toBe(true);
});

test("stop during source admission prevents every model call and never publishes running state", async () => {
  const f = await createHomeGenerationFixture();
  const reached = deferred<void>();
  const release = deferred<void>();
  f.context.capture.mockImplementationOnce(async () => { reached.resolve(); await release.promise; return f.sources; });
  const admission = f.service.start(start);
  const rejected = expect(admission).rejects.toMatchObject({ code: "spark_home_run_interrupted" });
  await reached.promise;
  expect(f.service.isIdle()).toBe(false);
  const stopped = f.service.stop();
  release.resolve();
  await rejected;
  await stopped;
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.saved()).toBeNull();
  expect(f.update).not.toHaveBeenCalled();
});
