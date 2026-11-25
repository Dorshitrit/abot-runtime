import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildOpenAIResponsesPayload } from "../../model-gateway/providers/openai/payload.js";
import { projectRegisteredToolResultEnvelope } from "../adapters/registered-tool-worker-capabilities/result-envelope.js";
import { buildExecutionAgentInput } from "../steps/execution-agent/input.js";
import { activeEvidenceCall, createControlsEvidenceFixture } from "./support/execution-controls-evidence-fixture.js";
import { executionPrefixCachePolicy } from "./support/execution-prefix-cache-fixture.js";
import { eaFixture } from "./support/filesystem-ea-fixture.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";

const fixtures: Awaited<ReturnType<typeof eaFixture>>[] = [];
beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => { resetDebugLoggerConfig(); await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose())); });
async function setup() {
  const fixture = await eaFixture(); fixtures.push(fixture);
  const request = await fixture.request();
  const file = join(fixture.paths.agentWorkDir, "text.txt");
  return { fixture, request, file };
}

test.each([
  { name: "ordinary", original: "old\r\n", replacement: "new\r\n" },
  { name: "unchanged", original: "same\r\n", replacement: "same\r\n" },
  { name: "delete", original: "remove\n", replacement: "" },
  { name: "empty", original: "", replacement: "" },
  { name: "large multibyte", original: "old\n", replacement: "🙂".repeat(20_000) },
  { name: "payload limit", original: "old\n", replacement: "x".repeat(262_144) },
])("$name edit returns a lightweight exact replacement reference reusable without a read", async ({ original, replacement }) => {
  const { fixture, request, file } = await setup();
  await writeFile(file, original);
  const read = await request.port.execute({ tool: "read_text", params: { path: "text.txt" } });
  const first = await request.prepareBody("edit_text", { path: "text.txt", range_ref: read.data?.range_ref }, replacement);
  const result = await first.prepared.execute();
  expect(result).toMatchObject({ status: "executed", result: { ok: true } });
  if (result.status !== "executed") throw new Error("expected_execution");
  const fresh = result.result.data?.range_ref;
  expect(fresh).toMatch(/^range:[a-f0-9-]{36}$/u);
  expect(fresh).not.toBe(read.data?.range_ref);
  expect(result.result.output).toContain(`range_ref: ${fresh}`);
  expect(await readFile(file, "utf8")).toBe(replacement);
  const state = JSON.parse(JSON.stringify(request.state.snapshot()));
  const saved = state["filesystem-ea.v1"].ranges.find((range: { id: unknown }) => range.id === fresh);
  expect(saved).toMatchObject({ origin: "committed_edit", start: 0, end: replacement.length });
  expect(saved).not.toHaveProperty("text");
  expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThan(1500);
  const restored = await fixture.request({ state });
  const second = await restored.prepareBody("edit_text", { path: "text.txt", range_ref: fresh }, "final\n");
  expect(second.source.context.sourceText).toBe(replacement);
  expect(await second.prepared.execute()).toMatchObject({ result: { ok: true } });
  expect(await readFile(file, "utf8")).toBe("final\n");
  expect(JSON.stringify(request.events)).not.toContain(String(fresh));
});

test("partial byte edits retain exact offsets, BOM, CRLF and unrelated content", async () => {
  const { request, file } = await setup();
  const prefix = "\uFEFFbefore\r\n"; const suffix = "\r\nafter";
  await writeFile(file, prefix + "🙂" + suffix);
  const read = await request.port.execute({ tool: "read_text", params: {
    path: "text.txt", start_byte: Buffer.byteLength(prefix), max_bytes: 4,
  } });
  const first = await request.prepareBody("edit_text", { path: "text.txt", range_ref: read.data?.range_ref }, "changed\r\n🙂");
  const result = await first.prepared.execute();
  if (result.status !== "executed") throw new Error("expected_execution");
  const next = await request.prepareBody("edit_text", { path: "text.txt", range_ref: result.result.data?.range_ref }, "");
  expect(next.source.context.sourceText).toBe("changed\r\n🙂");
  const deleted = await next.prepared.execute();
  if (deleted.status !== "executed") throw new Error("expected_execution");
  const insert = await request.prepareBody("edit_text", { path: "text.txt", range_ref: deleted.result.data?.range_ref }, "inserted");
  expect(insert.source.context.sourceText).toBe("");
  expect(await insert.prepared.execute()).toMatchObject({ result: { ok: true } });
  expect(await readFile(file, "utf8")).toBe(prefix + "inserted" + suffix);
});

test("old, wrong-path, cross-request and externally changed references remain rejected", async () => {
  const { fixture, request, file } = await setup();
  await writeFile(file, "old");
  await writeFile(join(fixture.paths.agentWorkDir, "other.txt"), "new");
  const read = await request.port.execute({ tool: "read_text", params: { path: "text.txt" } });
  const first = await request.prepareBody("edit_text", { path: "text.txt", range_ref: read.data?.range_ref }, "new");
  const result = await first.prepared.execute();
  if (result.status !== "executed") throw new Error("expected_execution");
  const fresh = result.result.data?.range_ref;
  await expect(request.prepareBody("edit_text", { path: "text.txt", range_ref: read.data?.range_ref }, "bad"))
    .rejects.toMatchObject({ code: "filesystem_target_changed" });
  await expect(request.prepareBody("edit_text", { path: "other.txt", range_ref: fresh }, "bad"))
    .rejects.toMatchObject({ code: "ea_range_invalid" });
  const unrelated = await fixture.request({ requestId: "other-request" });
  await expect(unrelated.prepareBody("edit_text", { path: "text.txt", range_ref: fresh }, "bad"))
    .rejects.toMatchObject({ code: "ea_range_invalid" });
  await writeFile(file, "external");
  await expect(request.prepareBody("edit_text", { path: "text.txt", range_ref: fresh }, "bad"))
    .rejects.toMatchObject({ code: "filesystem_target_changed" });
  expect(await readFile(file, "utf8")).toBe("external");
});

test("fresh reference survives canonical result capture and the actual EA OpenAI message projection", async () => {
  const { request, file } = await setup();
  await writeFile(file, "old");
  const read = await request.port.execute({ tool: "read_text", params: { path: "text.txt" } });
  const edit = await request.prepareBody("edit_text", { path: "text.txt", range_ref: read.data?.range_ref }, "new");
  const result = await edit.prepared.execute();
  if (result.status !== "executed") throw new Error("expected_execution");
  const fresh = result.result.data?.range_ref;
  const exactResult = projectRegisteredToolResultEnvelope(result.result, result.result.actions ?? []);
  const f = await createControlsEvidenceFixture({ modelPolicy: executionPrefixCachePolicy });
  const call = activeEvidenceCall(f.ledger.current());
  await f.commit({ authority: "active_role", type: "begin_capability_execution", callId: call.callId,
    invocationAttempt: call.activationCount, capabilityId: "edit_text", declaredEffect: "mutation",
    intent: "Change selected text.", controlsJson: JSON.stringify({ path: "text.txt", range_ref: read.data?.range_ref }) });
  const execution = f.ledger.current().state.capabilityExecutions.at(-1)!;
  await f.commit({ authority: "runtime", type: "settle_capability_execution", callId: call.callId, executionId: execution.executionId,
    outcome: "succeeded", observedEffect: "mutation", summary: result.result.output, exactResult });
  const head = f.ledger.current();
  const input = buildExecutionAgentInput(f.request, { head, call: activeEvidenceCall(head),
    steeringSnapshot: f.steering.snapshot(), includeAcknowledgement: false, includeTitle: false, allowPlanner: true, allowAuditor: true });
  const payload = buildOpenAIResponsesPayload({ modelPolicy: f.request.modelPolicy, agentMode: f.request.agentMode,
    modelStep: input.modelStep, messages: [...input.messages], format: input.format });
  const serialized = JSON.stringify(payload.input);
  expect(serialized).toContain(String(fresh));
  expect(serialized).toContain("exact replacement text");
  const carried = JSON.parse(input.messages.find((message) => message.role === "tool")!.content);
  expect(carried.result.adapterResult.result.data.range_ref).toBe(fresh);
});
