import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { validateToolNormalInvocationInput } from "../../capabilities/normal-invocation/index.js";
import { eaFixture } from "./support/filesystem-ea-fixture.js";

type Fixture = Awaited<ReturnType<typeof eaFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose())); });

async function setup() {
  const fixture = await eaFixture(); fixtures.push(fixture);
  const file = join(fixture.paths.agentWorkDir, "text.txt");
  await writeFile(file, "first\nsecond\nthird");
  const request = await fixture.request();
  const read = request.executor.operations.find(({ operation }) => operation.operationId === "read_text")!;
  return { fixture, file, request, read };
}

test("installed EA registry declares read families and preserves mutation contracts", async () => {
  const { request, read } = await setup();
  expect(read.operation.input.anyOf).toEqual([
    { propertyNames: { enum: ["path", "start_byte", "max_bytes"] } },
    { propertyNames: { enum: ["path", "start_line", "end_line", "locator", "context_lines"] } },
  ]);
  expect(request.executor.operations.map(({ operation }) => operation.operationId).sort())
    .toEqual(["create_text", "edit_text", "read_text"]);
  for (const [id, names] of [["create_text", ["path"]], ["edit_text", ["path", "range_ref"]]] as const) {
    const operation = request.executor.operations.find(({ operation }) => operation.operationId === id)!.operation;
    expect(operation.input).not.toHaveProperty("anyOf");
    expect(operation.input.required).toEqual(names);
    expect(Object.keys(operation.input.properties)).toEqual(names);
    expect(operation.input.additionalProperties).toBe(false);
    expect(operation.payload).toMatchObject({ kind: "raw_text", minBytes: 0, maxBytes: 262_144 });
  }
});

test.each([
  [{}, "first\nsecond\nthird"],
  [{ max_bytes: 5 }, "first"],
  [{ start_byte: 6, max_bytes: 6 }, "second"],
  [{ start_byte: 6 }, "second\nthird"],
  [{ start_line: 2 }, "second\nthird"],
  [{ end_line: 2 }, "first\nsecond\n"],
  [{ start_line: 2, end_line: 2 }, "second\n"],
  [{ locator: "second", context_lines: 1 }, "first\nsecond\nthird"],
  [{ start_line: 3, end_line: 3, locator: "second", context_lines: 1 }, "first\nsecond\nthird"],
  [{ context_lines: 1 }, "first\nsecond\nthird"],
  [{ start_line: 2, end_line: 2, context_lines: 1 }, "second\n"],
] as const)("preserves documented reads and accepted selector combinations: %j", async (controls, expected) => {
  const { request, read } = await setup();
  const accepted = { path: "text.txt", ...controls };
  expect(validateToolNormalInvocationInput(read.operation, accepted)).toEqual({ ok: true, value: accepted });
  const prepared = await request.executor.prepare({ handle: read.handle, controls: accepted });
  expect(prepared.status).toBe("prepared");
  if (prepared.status !== "prepared") throw new Error("expected_prepared_read");
  const result = await prepared.execute();
  expect(result.status).toBe("executed");
  if (result.status !== "executed") throw new Error("expected_executed_read");
  expect(result.result.ok).toBe(true);
  expect(result.result.output.split("Content:\n")[1]).toBe(expected);
});

const byteControls = [{ start_byte: 0 }, { max_bytes: 24_000 }];
const lineControls = [{ start_line: 1 }, { end_line: 2 }, { locator: "second" }, { context_lines: 1 }];
test.each(byteControls.flatMap((bytes) => lineControls.map((lines) => ({ ...bytes, ...lines }))))(
  "rejects every conflicting family before tool execution: %j", async (controls) => {
    const { file, request, read } = await setup();
    const params = { path: "text.txt", ...controls };
    expect(validateToolNormalInvocationInput(read.operation, params))
      .toEqual({ ok: false, issue: "input properties do not match a declared mode" });
    expect(await request.executor.prepare({ handle: read.handle, controls: params }))
      .toMatchObject({ status: "rejected", code: "normal_invocation_input_invalid",
        message: "input properties do not match a declared mode" });
    expect(request.events).toEqual([]);
    expect(await readFile(file, "utf8")).toBe("first\nsecond\nthird");
    // The adapter still protects callers that bypass normal invocation validation.
    expect(await request.port.execute({ tool: "read_text", params }))
      .toMatchObject({ ok: false, errorCode: "ea_read_range_invalid" });
  },
);

test.each([
  {}, { path: "text.txt", start_byte: null }, { path: "text.txt", max_bytes: null },
  { path: "text.txt", start_line: null }, { path: "text.txt", start_byte: -1 },
  { path: "text.txt", max_bytes: 24_001 }, { path: "text.txt", locator: "" },
  { path: "text.txt", context_lines: 31 }, { path: "text.txt", unknown: 1 },
])("does not weaken scalar, null, required or unknown-field rejection: %j", async (controls) => {
  const { request, read } = await setup();
  expect(await request.executor.prepare({ handle: read.handle, controls }))
    .toMatchObject({ status: "rejected", code: "normal_invocation_input_invalid" });
  expect(request.events).toEqual([]);
});
