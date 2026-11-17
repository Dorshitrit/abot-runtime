import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { eaFixture } from "./support/filesystem-ea-fixture.js";

const fixtures: Awaited<ReturnType<typeof eaFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

async function setup() {
  const fixture = await eaFixture();
  fixtures.push(fixture);
  return fixture;
}

function changedTextFrom(grounding: unknown): string {
  expect(typeof grounding).toBe("string");
  const window = String(grounding).match(
    /BEGIN EXACT COMMITTED CHANGED WINDOW lines \d+-\d+\n([\s\S]*?)\nEND EXACT COMMITTED CHANGED WINDOW/u,
  );
  expect(window).not.toBeNull();
  return window![1]!;
}

test.each([
  { name: "LF", content: "before\nfirst = 1;\nlast = 2;\nafter\n" },
  { name: "CRLF", content: "before\r\nfirst = 1;\r\nlast = 2;\r\nafter\r\n" },
  { name: "mixed endings", content: "before\r\nfirst = 1;\nlast = 2;\r\nafter\n" },
  { name: "no final LF", content: "before\nfirst = 1;\nlast = 2;\nafter" },
  { name: "no final CRLF", content: "before\r\nfirst = 1;\r\nlast = 2;\r\nafter" },
  { name: "form feed", content: "before\f\nfirst = 1;\nlast = 2;\nafter\n" },
  { name: "escape", content: "before\u001b\nfirst = 1;\nlast = 2;\nafter\n" },
  { name: "NEL", content: "before\u0085\nfirst = 1;\nlast = 2;\nafter\n" },
])("$name mutation evidence stays exact across range edits and fresh reads", async ({ content }) => {
  const fixture = await setup();
  const request = await fixture.request();
  const file = join(fixture.paths.agentWorkDir, "code.txt");
  await writeFile(file, content);
  const observed = await request.port.execute({ tool: "read_text", params: { path: "code.txt", start_line: 2, end_line: 2 } });
  const first = await request.prepareBody("edit_text", { path: "code.txt", range_ref: observed.data?.range_ref },
    observed.output.split("Content:\n")[1]!.replace("first = 1", "first = 3"));
  const firstResult = await first.prepared.execute();
  expect(firstResult).toMatchObject({ status: "executed", result: { ok: true } });
  if (firstResult.status !== "executed") throw new Error("expected_execution");
  expect(await readFile(file)).toEqual(Buffer.from(content.replace("first = 1", "first = 3")));

  const transported = JSON.parse(JSON.stringify(firstResult.result));
  expect(transported.data?.mutationGrounding).toBe(firstResult.result.data?.mutationGrounding);
  const committedText = changedTextFrom(transported.data?.mutationGrounding);
  expect(content.replace("first = 1", "first = 3")).toContain(committedText);
  expect(committedText).toContain("last = 2");
  const fresh = await request.port.execute({ tool: "read_text", params: { path: "code.txt", start_line: 3, end_line: 3 } });
  const second = await request.prepareBody("edit_text", { path: "code.txt", range_ref: fresh.data?.range_ref },
    fresh.output.split("Content:\n")[1]!.replace("last = 2", "last = 4"));
  expect(await second.prepared.execute()).toMatchObject({ result: { ok: true } });
  expect(await readFile(file)).toEqual(Buffer.from(
    content.replace("first = 1", "first = 3").replace("last = 2", "last = 4"),
  ));
});

test("large-file mutation evidence retains exact local bytes without unrelated distant content", async () => {
  const fixture = await setup();
  const request = await fixture.request();
  const file = join(fixture.paths.agentWorkDir, "large.txt");
  const middle = Array.from({ length: 1200 }, (_, index) =>
    index === 600 ? "target = 1;\r\n" : `row ${index}: ${"🙂".repeat(8)}\r\n`,
  ).join("");
  const content = `far-start-only\r\n${middle}far-end-only\r\n`;
  expect(content.length).toBeGreaterThan(30_000);
  await writeFile(file, content);
  const observed = await request.port.execute({ tool: "read_text", params: { path: "large.txt", locator: "target = 1", context_lines: 1 } });
  const first = await request.prepareBody("edit_text", { path: "large.txt", range_ref: observed.data?.range_ref },
    observed.output.split("Content:\n")[1]!.replace("target = 1", "target = 3"));
  const firstResult = await first.prepared.execute();
  expect(firstResult).toMatchObject({ result: { ok: true, data: {
    truncation: { groundingCoverage: "changed_window", groundingTruncated: false },
  } } });
  if (firstResult.status !== "executed") throw new Error("expected_execution");
  const grounding = String(firstResult.result.data?.mutationGrounding);
  expect(grounding.length).toBeLessThanOrEqual(32_768);
  expect(grounding).not.toContain("far-start-only");
  expect(grounding).not.toContain("far-end-only");
  expect(grounding).not.toContain("�");
  const committedText = changedTextFrom(grounding);
  expect(content.replace("target = 1", "target = 3")).toContain(committedText);
  const fresh = await request.port.execute({ tool: "read_text", params: { path: "large.txt", locator: "target = 3", context_lines: 1 } });
  const second = await request.prepareBody("edit_text", { path: "large.txt", range_ref: fresh.data?.range_ref },
    fresh.output.split("Content:\n")[1]!.replace("target = 3", "target = 4"));
  expect(await second.prepared.execute()).toMatchObject({ result: { ok: true } });
  expect(await readFile(file)).toEqual(Buffer.from(content.replace("target = 1", "target = 4")));
});
