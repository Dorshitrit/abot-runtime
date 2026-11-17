import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { eaFixture } from "./support/filesystem-ea-fixture.js";

type Fixture = Awaited<ReturnType<typeof eaFixture>>;
type Request = Awaited<ReturnType<Fixture["request"]>>;
const fixtures: Fixture[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose())); });
async function setup(content: string) {
  const fixture = await eaFixture(); fixtures.push(fixture);
  const file = join(fixture.paths.agentWorkDir, "text.txt");
  await writeFile(file, content);
  return { fixture, file, request: await fixture.request() };
}
function read(request: Request, controls: Record<string, unknown>) {
  return request.port.execute({ tool: "read_text", params: { path: "text.txt", ...controls } });
}
function content(result: Awaited<ReturnType<typeof read>>) {
  expect(result.ok).toBe(true);
  return result.output.slice(result.output.indexOf("Content:\n") + "Content:\n".length);
}

test("byte pagination reaches a long single-line tail and binds only the selected window", async () => {
  const original = "a".repeat(48_000) + "tail-target";
  const { request, file } = await setup(original);
  const first = await read(request, { start_byte: 0 });
  expect(first.data).toMatchObject({ start_byte: 0, end_byte: 24_000, next_byte: 24_000,
    range_ref: expect.any(String), eventMeta: { byteCount: 24_000, truncated: false, complete: false } });
  expect(content(first)).toBe(original.slice(0, 24_000));
  expect(first.output).toMatch(/Bytes: 0-24000\b/);
  expect(first.output).toMatch(/next_byte: 24000\b/);
  const second = await read(request, { start_byte: first.data?.next_byte });
  expect(second.data).toMatchObject({ start_byte: 24_000, end_byte: 48_000, next_byte: 48_000 });
  const tail = await read(request, { start_byte: second.data?.next_byte });
  expect(content(first) + content(second) + content(tail)).toBe(original);
  expect(content(tail)).toBe("tail-target");
  expect(tail.data).toMatchObject({ start_byte: 48_000, end_byte: original.length,
    eventMeta: { truncated: false, complete: false } });
  expect(tail.data).not.toHaveProperty("next_byte");
  const edit = await request.prepareBody("edit_text", { path: "text.txt", range_ref: tail.data?.range_ref }, "fixed");
  expect(edit.source.context.sourceText).toBe("tail-target");
  expect(await edit.prepared.execute()).toMatchObject({ result: { ok: true } });
  expect(await readFile(file, "utf8")).toBe("a".repeat(48_000) + "fixed");
});

test("a sub-line byte range edits exact Unicode bytes while preserving both surroundings", async () => {
  const prefix = "\uFEFFbefore🙂\r\n";
  const selected = "שלום🙂";
  const suffix = "\r\nafter\uFEFF";
  const original = prefix + selected + suffix;
  const { request, file } = await setup(original);
  const start_byte = Buffer.byteLength(prefix);
  expect(start_byte).not.toBe(prefix.length);
  const selectedRead = await read(request, { start_byte, max_bytes: Buffer.byteLength(selected) });
  expect(content(selectedRead)).toBe(selected);
  expect(selectedRead.data).toMatchObject({ start_byte, end_byte: start_byte + Buffer.byteLength(selected),
    next_byte: start_byte + Buffer.byteLength(selected), eventMeta: { truncated: false, complete: false } });
  const edit = await request.prepareBody("edit_text", { path: "text.txt", range_ref: selectedRead.data?.range_ref }, "חדש🚀");
  expect(edit.source.context.sourceText).toBe(selected);
  expect(await edit.prepared.execute()).toMatchObject({ result: { ok: true } });
  expect(await readFile(file)).toEqual(Buffer.from(prefix + "חדש🚀" + suffix));
});

test.each([
  { source: "\uFEFFabc", max_bytes: 3, expected: "\uFEFF", end_byte: 3 },
  { source: "a🙂b", max_bytes: 4, expected: "a", end_byte: 1 },
  { source: "ש🙂b", max_bytes: 5, expected: "ש", end_byte: 2 },
  { source: "🙂z", max_bytes: 4, expected: "🙂", end_byte: 4 },
  { source: "a\r\nb", max_bytes: 2, expected: "a\r", end_byte: 2 },
])("byte window backs off safely: $source / $max_bytes", async ({ source, max_bytes, expected, end_byte }) => {
  const { request } = await setup(source);
  const result = await read(request, { start_byte: 0, max_bytes });
  expect(content(result)).toBe(expected);
  expect(result.data).toMatchObject({ start_byte: 0, end_byte, next_byte: end_byte,
    eventMeta: { byteCount: Buffer.byteLength(expected), truncated: false, complete: false } });
  const prepared = await request.prepareBody("edit_text", { path: "text.txt", range_ref: result.data?.range_ref }, expected);
  expect(prepared.source.context.sourceText).toBe(expected);
  expect(content(await read(request, { start_byte: result.data?.next_byte }))).toBe(source.slice(expected.length));
});

test.each([
  { start_byte: 1 }, { start_byte: 2 }, { start_byte: 4 }, { start_byte: 7 }, { start_byte: 8 }, { start_byte: 9 },
  { start_byte: -1 }, { start_byte: 0.5 }, { start_byte: 12 }, { start_byte: null }, { start_byte: "0" },
  { start_byte: 0, max_bytes: 0 }, { start_byte: 0, max_bytes: 24_001 },
  { start_byte: 0, max_bytes: 1.5 }, { start_byte: 0, max_bytes: null },
  { start_byte: 0, max_bytes: 1 }, { start_byte: 3, max_bytes: 1 }, { start_byte: 6, max_bytes: 3 },
])("invalid byte boundary or budget is rejected before any reference: %j", async (controls) => {
  // Byte positions: BOM [0,3), ש [3,5), x [5,6), 🙂 [6,10), z [10,11).
  const original = "\uFEFFשx🙂z";
  const { request, file } = await setup(original);
  const result = await read(request, controls);
  expect(result).toMatchObject({ ok: false, errorCode: "ea_read_range_invalid" });
  expect(result.data?.range_ref).toBeUndefined();
  expect(await readFile(file)).toEqual(Buffer.from(original));
});

test.each([
  { start_line: 1 }, { end_line: 1 }, { locator: "abc" }, { context_lines: 1 },
  { start_line: null }, { locator: null },
])("byte selection cannot silently override a second selector: %j", async (selector) => {
  const { request } = await setup("abc\ndef");
  expect(await read(request, { start_byte: 0, ...selector }))
    .toMatchObject({ ok: false, errorCode: "ea_read_range_invalid" });
});

test.each(["", "\uFEFFשלום🙂\r\n"])("EOF is a valid empty range for %j", async (original) => {
  const { request, file } = await setup(original);
  const start_byte = Buffer.byteLength(original);
  const result = await read(request, { start_byte });
  expect(content(result)).toBe("");
  expect(result.data).toMatchObject({ start_byte, end_byte: start_byte, range_ref: expect.any(String),
    eventMeta: { byteCount: 0, truncated: false, complete: original.length === 0 } });
  expect(result.data).not.toHaveProperty("next_byte");
  const edit = await request.prepareBody("edit_text", { path: "text.txt", range_ref: result.data?.range_ref }, "added");
  expect(edit.source.context.sourceText).toBe("");
  expect(await edit.prepared.execute()).toMatchObject({ result: { ok: true } });
  expect(await readFile(file)).toEqual(Buffer.from(original + "added"));
});

test("a complete byte read and legacy selectors keep their distinct coverage metadata", async () => {
  const original = "\uFEFFשלום🙂\r\nsecond\r\n";
  const { request, file } = await setup(original);
  const complete = await read(request, { start_byte: 0 });
  expect(content(complete)).toBe(original);
  expect(complete.data).toMatchObject({ start_byte: 0, end_byte: Buffer.byteLength(original),
    eventMeta: { complete: true, truncated: false } });
  expect(complete.data).not.toHaveProperty("next_byte");
  for (const controls of [{}, { start_line: 1, end_line: 1 }, { locator: "second", context_lines: 1 }]) {
    const result = await read(request, controls);
    expect(result.ok).toBe(true);
    expect(result.data?.range_ref).toEqual(expect.any(String));
    for (const key of ["start_byte", "end_byte", "next_byte"]) expect(result.data).not.toHaveProperty(key);
    expect(result.output).not.toContain("Bytes:");
  }
  await writeFile(file, "a".repeat(24_001));
  for (const controls of [{}, { start_line: 1, end_line: 1 }, { locator: "a", context_lines: 1 }]) {
    const result = await read(request, controls);
    expect(result.data?.eventMeta).toMatchObject({ truncated: true, complete: false });
    expect(result.data?.range_ref).toBeUndefined();
  }
});

test("byte references retain request, path and revision protection through edit execution", async () => {
  const { fixture, request, file } = await setup("before🙂after");
  const selected = await read(request, { start_byte: 6, max_bytes: 4 });
  const controls = { path: "text.txt", range_ref: selected.data?.range_ref };
  await writeFile(join(fixture.paths.agentWorkDir, "other.txt"), "before🙂after");
  await expect(request.prepareBody("edit_text", { ...controls, path: "other.txt" }, "x"))
    .rejects.toMatchObject({ code: "ea_range_invalid" });
  const other = await fixture.request({ requestId: "different-request" });
  await expect(other.prepareBody("edit_text", controls, "x")).rejects.toMatchObject({ code: "ea_range_invalid" });
  const edit = await request.prepareBody("edit_text", controls, "x");
  await writeFile(file, "external change");
  expect(await edit.prepared.execute()).toMatchObject({ result: { ok: false, errorCode: "filesystem_target_changed" } });
  await expect(request.prepareBody("edit_text", controls, "x"))
    .rejects.toMatchObject({ code: "filesystem_target_changed" });
  expect(await readFile(file, "utf8")).toBe("external change");
});

test("approval restoration reuses the selected byte source and exact prepared replacement", async () => {
  const prefix = "\uFEFFשלום\r\n";
  const original = prefix + "🙂" + "\r\nuntouched";
  const { fixture, file } = await setup(original);
  const request = await fixture.request({ permission: "ask" });
  const selected = await read(request, { start_byte: Buffer.byteLength(prefix), max_bytes: 4 });
  const controls = { path: "text.txt", range_ref: selected.data?.range_ref };
  const edit = await request.prepareBody("edit_text", controls, "🚀");
  expect(edit.prepared.approvalRequest).toBeDefined();
  expect(edit.source.context.sourceText).toBe("🙂");
  expect(await readFile(file, "utf8")).toBe(original);
  const restored = await fixture.request({ state: request.state.snapshot(), permission: "ask" });
  const operation = restored.executor.operations.find((entry) => entry.operation.operationId === "edit_text")!;
  expect((await operation.preparePayload!(controls)).context.sourceText).toBe("🙂");
  const resumed = await restored.executor.restore(edit.prepared.snapshot);
  if (resumed.status !== "prepared") throw new Error("expected_prepared");
  expect(resumed.actionFingerprint).toBe(edit.prepared.actionFingerprint);
  resumed.applyApprovalDecision({ approvalId: resumed.approvalRequest!.approvalId,
    actionFingerprint: resumed.actionFingerprint, decision: { approved: true } });
  expect(await resumed.execute()).toMatchObject({ result: { ok: true } });
  expect(await readFile(file)).toEqual(Buffer.from(prefix + "🚀\r\nuntouched"));
});
