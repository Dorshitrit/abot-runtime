import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { MAX_AUTHORED_BYTES } from "../../../plugins/filesystem-ea/source/payload-source.js";
import { eaFixture } from "./support/filesystem-ea-fixture.js";

const fixtures: Awaited<ReturnType<typeof eaFixture>>[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose())); });

async function setup(tool: "create_text" | "edit_text", permission: "ask" | "full_access" = "full_access") {
  const fixture = await eaFixture(); fixtures.push(fixture);
  const request = await fixture.request({ permission });
  const file = join(fixture.paths.agentWorkDir, "text.txt");
  const controls: Record<string, unknown> = { path: "text.txt" };
  if (tool === "edit_text") {
    await writeFile(file, "old");
    const read = await request.port.execute({ tool: "read_text", params: controls });
    controls.range_ref = read.data?.range_ref;
  }
  const projection = request.executor.operations.find((entry) => entry.operation.operationId === tool)!;
  return { fixture, request, file, controls, projection };
}

test.each(["create_text", "edit_text"] as const)("%s declares and enforces the same UTF-8 content limit", async (tool) => {
  const { request, file, controls, projection } = await setup(tool);
  expect(projection.operation.payload?.maxBytes).toBe(MAX_AUTHORED_BYTES);
  expect(MAX_AUTHORED_BYTES).toBe(256 * 1024);
  const source = await projection.preparePayload!(controls);
  expect(source.context.maxBytes).toBe(MAX_AUTHORED_BYTES);
  const oversized = "🙂".repeat(MAX_AUTHORED_BYTES / 4) + "x";
  expect(() => source.bind(oversized)).toThrow("payload exceeds");
  const payload = source.bind("valid");
  const tampered = JSON.stringify({ ...JSON.parse(payload), body: oversized });
  expect(await request.executor.prepare({ handle: projection.handle, controls, payload: tampered }))
    .toMatchObject({ status: "rejected", code: "normal_invocation_payload_invalid" });
  if (tool === "edit_text") expect(await readFile(file, "utf8")).toBe("old");
  if (tool === "create_text") await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["", "unexpected", "🙂"])("payload-free reads reject an unexpected payload: %j", async (payload) => {
  const { request, file } = await setup("edit_text");
  const read = request.executor.operations.find((entry) => entry.operation.operationId === "read_text")!;
  const input = { handle: read.handle, controls: { path: "text.txt" } };
  expect(await request.executor.prepare({ ...input, payload })).toMatchObject({
    status: "rejected", code: "normal_invocation_payload_invalid",
  });
  expect(await request.executor.prepare(input)).toMatchObject({ status: "prepared" });
  expect(await readFile(file, "utf8")).toBe("old");
});

const atLimit = [
  { name: "ASCII", body: "x".repeat(MAX_AUTHORED_BYTES) },
  { name: "UTF-8", body: "🙂".repeat(MAX_AUTHORED_BYTES / 4) },
  { name: "JSON escaping", body: "\"\\\n\t".repeat(MAX_AUTHORED_BYTES / 4) },
];
for (const tool of ["create_text", "edit_text"] as const) {
  test.each(atLimit)(`${tool} accepts exactly 256 KiB of $name content`, async ({ body }) => {
    const { request, file, controls } = await setup(tool);
    expect(Buffer.byteLength(body)).toBe(MAX_AUTHORED_BYTES);
    const { prepared, payload } = await request.prepareBody(tool, controls, body);
    expect(Buffer.byteLength(payload)).toBeGreaterThan(MAX_AUTHORED_BYTES);
    expect(await prepared.execute()).toMatchObject({ result: { ok: true } });
    expect(await readFile(file, "utf8")).toBe(body);
  });
}

test("a full-size escaped payload survives approval restore with identical bytes", async () => {
  const { fixture, request, file, controls } = await setup("create_text", "ask");
  const body = "\"\\\n\t".repeat(MAX_AUTHORED_BYTES / 4);
  const { prepared } = await request.prepareBody("create_text", controls, body);
  const restored = await fixture.request({ state: request.state.snapshot(), permission: "ask" });
  const resumed = await restored.executor.restore(prepared.snapshot);
  if (resumed.status !== "prepared") throw new Error("expected_prepared");
  expect(resumed.actionFingerprint).toBe(prepared.actionFingerprint);
  resumed.applyApprovalDecision({ approvalId: resumed.approvalRequest!.approvalId,
    actionFingerprint: resumed.actionFingerprint, decision: { approved: true } });
  expect(await resumed.execute()).toMatchObject({ result: { ok: true } });
  expect(await readFile(file, "utf8")).toBe(body);
});
