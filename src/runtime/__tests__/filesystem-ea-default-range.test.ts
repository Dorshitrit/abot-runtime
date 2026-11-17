import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { eaFixture } from "./support/filesystem-ea-fixture.js";
import { projectRegisteredToolCapabilityControls } from "../adapters/registered-tool-worker-capabilities/control-documentation.js";
import { normalizeGeneratedExecutionCapabilityControls } from "../steps/execution-agent/capability-invocation-contract.js";

type Fixture = Awaited<ReturnType<typeof eaFixture>>;
type Request = Awaited<ReturnType<Fixture["request"]>>;
const fixtures: Fixture[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose())); });

async function setup(original: string) {
  const fixture = await eaFixture(); fixtures.push(fixture);
  const file = join(fixture.paths.agentWorkDir, "text.txt");
  await writeFile(file, original);
  return { file, request: await fixture.request() };
}

function read(request: Request, controls: Record<string, unknown> = {}) {
  return request.port.execute({ tool: "read_text", params: { path: "text.txt", ...controls } });
}

function body(result: Awaited<ReturnType<typeof read>>) {
  expect(result.ok).toBe(true);
  return result.output.slice(result.output.indexOf("Content:\n") + "Content:\n".length);
}

test.each([
  "", "hello without a final newline", "\uFEFFשלום🙂\r\nsecond\r\n",
  Array.from({ length: 120 }, (_, index) => `row ${index}\r\n`).join(""),
])("an omitted selector returns exact complete contents through EOF: %j", async (original) => {
  const { request, file } = await setup(original);
  const result = await read(request);
  expect(body(result)).toBe(original);
  expect(result.data).toMatchObject({ range_ref: expect.any(String),
    eventMeta: { startLine: 1, complete: true, truncated: false, byteCount: Buffer.byteLength(original) } });
  expect(result.data).not.toHaveProperty("start_byte");
  expect(await readFile(file)).toEqual(Buffer.from(original));
});

test("a default range binds only its first 120 lines and editing preserves the unseen tail", async () => {
  const first = "\uFEFF" + Array.from({ length: 120 }, (_, index) => `row ${index} שלום🙂\r\n`).join("");
  const tail = "unseen line 121\r\nlast line without newline";
  const { request, file } = await setup(first + tail);
  const result = await read(request);
  expect(body(result)).toBe(first);
  expect(result.data).toMatchObject({ range_ref: expect.any(String), eventMeta: {
    startLine: 1, endLine: 120, totalLines: 122, complete: false, truncated: false,
  } });
  await read(request, { start_line: 121 });
  const edit = await request.prepareBody("edit_text",
    { path: "text.txt", range_ref: result.data?.range_ref }, "replaced observed lines\r\n");
  expect(edit.source.context.sourceText).toBe(first);
  expect(await edit.prepared.execute()).toMatchObject({ result: { ok: true } });
  expect(await readFile(file)).toEqual(Buffer.from("replaced observed lines\r\n" + tail));
});

test("the default line range retains the UTF-8 byte budget and withholds a truncated reference", async () => {
  const original = "🙂".repeat(7_000) + "\nuntouched tail";
  const { request, file } = await setup(original);
  const result = await read(request);
  expect(body(result)).toBe("🙂".repeat(6_000));
  expect(result.data?.eventMeta).toMatchObject({ byteCount: 24_000, complete: false, truncated: true });
  expect(result.data?.range_ref).toBeUndefined();
  expect(await readFile(file)).toEqual(Buffer.from(original));
});

test("nullable generated selectors with max_bytes use the default range after runtime normalization", async () => {
  const rows = Array.from({ length: 150 }, (_, index) => `row ${index + 1}\n`);
  const { request } = await setup(rows.join(""));
  const operation = request.executor.operations.find((entry) => entry.operation.operationId === "read_text")!;
  const schema = projectRegisteredToolCapabilityControls(operation.operation.input);
  if (!schema.ok) throw new Error("expected_read_controls_schema");
  const params = normalizeGeneratedExecutionCapabilityControls({
    path: "text.txt", start_byte: null, max_bytes: 24_000, start_line: null,
    end_line: null, locator: null, context_lines: null,
  }, schema.controls) as Record<string, unknown>;
  expect(params).toEqual({ path: "text.txt", max_bytes: 24_000 });
  const result = await request.port.execute({ tool: "read_text", params });
  expect(body(result)).toBe(rows.slice(0, 120).join(""));
  expect(result.data).toMatchObject({ range_ref: expect.any(String),
    eventMeta: { startLine: 1, endLine: 120, complete: false, truncated: false } });
  expect(result.data).not.toHaveProperty("start_byte");
});

test.each([
  { max_bytes: 1, expected: "" },
  { max_bytes: 3, expected: "\uFEFF" },
  { max_bytes: 5, expected: "\uFEFFש" },
  { max_bytes: 8, expected: "\uFEFFש" },
  { max_bytes: 9, expected: "\uFEFFש🙂" },
])("max_bytes alone caps the default preview without splitting UTF-8: $max_bytes", async ({ max_bytes, expected }) => {
  const { request } = await setup("\uFEFFש🙂tail");
  const result = await read(request, { max_bytes });
  expect(body(result)).toBe(expected);
  expect(result.data?.eventMeta).toMatchObject({ byteCount: Buffer.byteLength(expected), truncated: true, complete: false });
  expect(result.data?.range_ref).toBeUndefined();
  expect(result.data).not.toHaveProperty("start_byte");
});

test("explicit partial line bounds and a locator can select beyond the default window", async () => {
  const rows = Array.from({ length: 180 }, (_, index) => `row ${index + 1}\n`);
  const original = rows.join("");
  const { request } = await setup(original);
  expect(body(await read(request, { start_line: 1 }))).toBe(original);
  expect(body(await read(request, { start_line: 121 }))).toBe(rows.slice(120).join(""));
  expect(body(await read(request, { end_line: 150 }))).toBe(rows.slice(0, 150).join(""));
  expect(body(await read(request, { start_line: 149, end_line: 151 }))).toBe(rows.slice(148, 151).join(""));
  expect(body(await read(request, { locator: "row 150\n", context_lines: 1 })))
    .toBe(rows.slice(148, 151).join(""));
  const bytes = await read(request, { start_byte: 0, max_bytes: Buffer.byteLength(original) });
  expect(body(bytes)).toBe(original);
  expect(bytes.data).toMatchObject({ start_byte: 0, end_byte: Buffer.byteLength(original),
    eventMeta: { complete: true, truncated: false } });
});

test.each([
  { start_line: 0 }, { end_line: 0 }, { start_line: null }, { end_line: null },
  { start_line: 2, end_line: 1 }, { start_line: 4 },
  { max_bytes: 0 }, { max_bytes: 24_001 }, { max_bytes: null }, { max_bytes: 1.5 },
  { max_bytes: 120, start_line: 1 }, { max_bytes: 120, end_line: 1 },
  { max_bytes: 120, locator: "first" }, { max_bytes: 120, context_lines: 1 },
])("an explicit invalid selector is not replaced by the default: %j", async (controls) => {
  const { request, file } = await setup("first\nsecond\nthird");
  const result = await read(request, controls);
  expect(result).toMatchObject({ ok: false, errorCode: "ea_read_range_invalid" });
  expect(result.data?.range_ref).toBeUndefined();
  expect(await readFile(file, "utf8")).toBe("first\nsecond\nthird");
});
