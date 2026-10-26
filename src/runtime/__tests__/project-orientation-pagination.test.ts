import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import createPlugin from "../../../plugins/project-orientation/source/index.js";
import { buildProjectInspectionPage } from "../../../plugins/project-orientation/source/result-page.js";
import { resolvePluginPath, type ToolImplementationOutput } from "../../plugin-sdk/index.js";
import { createRuntimeToolPathResolver } from "../capabilities/runtime-target-path.js";
import {
  createPortablePluginFixture,
  removePortablePluginFixtures,
} from "./windows-portable-plugins-fixture.js";

afterEach(removePortablePluginFixtures);

async function fixture() {
  const context = await createPortablePluginFixture("project-orientation");
  const root = context.runtimePaths.agentWorkDir;
  await mkdir(root);
  return { context, root, inspect: createPlugin(context).handlers.inspect_project! };
}

async function files(root: string, names: readonly string[]) {
  for (let offset = 0; offset < names.length; offset += 50) {
    await Promise.all(names.slice(offset, offset + 50).map((name) =>
      writeFile(join(root, name), "fixture"),
    ));
  }
}

const names = (count: number) => Array.from({ length: count }, (_, index) =>
  `file-${String(index).padStart(4, "0")}.txt`,
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  assert(Array.isArray(value));
  assert(value.every((entry: unknown): entry is string => typeof entry === "string"));
  return value;
}

function page(result: ToolImplementationOutput, offset = 0) {
  expect(result.ok).toBe(true);
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(4000);
  assert(isRecord(result.data));
  assert(isRecord(result.data.tree));
  assert(isRecord(result.data.pagination));
  const { tree, pagination } = result.data;
  const directories = stringList(tree.directories);
  const entries = [...directories, ...stringList(tree.files)];
  expect(tree.entries).toBe(entries.length);
  expect(entries.length).toBeLessThanOrEqual(40);
  expect(tree.truncatedPathCount).toBe(0);
  expect(tree.sampling).toBe("complete_bounded_directory_scan");
  assert(typeof pagination.hasMore === "boolean");
  assert(pagination.nextCursor === null || typeof pagination.nextCursor === "string");
  expect(tree.truncated).toBe(offset > 0 || pagination.hasMore);
  expect(pagination.nextCursor !== null).toBe(pagination.hasMore);
  for (const entry of entries) {
    expect(entry).not.toContain("…");
    expect(result.output).not.toContain(entry);
  }
  return { entries, directories, files: stringList(tree.files), cursor: pagination.nextCursor };
}

function failure(result: ToolImplementationOutput, errorCode: string) {
  expect(result).toMatchObject({ ok: false, errorCode, producedNewInformation: false });
  expect(result.data).toBeUndefined();
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(4000);
}

test("defaults to a flat overview while explicit depth retains each traversal level", async () => {
  const { root, inspect } = await fixture();
  await mkdir(join(root, "src", "deep"), { recursive: true });
  await files(root, ["root.txt"]);
  await files(join(root, "src"), ["index.ts"]);
  await files(join(root, "src", "deep"), ["leaf.ts"]);
  const initial = await inspect({});
  expect(initial).toMatchObject({ data: { depth: 0, maxEntries: 40 } });
  expect(page(initial)).toMatchObject({
    directories: ["src"], files: ["root.txt"], cursor: null,
  });
  expect(page(await inspect({ depth: 1 }))).toMatchObject({
    directories: ["src", "src/deep"], files: ["root.txt", "src/index.ts"], cursor: null,
  });
  expect(page(await inspect({ depth: 6 })).files).toEqual([
    "root.txt", "src/index.ts", "src/deep/leaf.ts",
  ]);
});

test("all pages cover a listing exactly once and replay the same cursor deterministically", async () => {
  const { root, inspect } = await fixture();
  const expected = names(93);
  await files(root, [...expected].reverse());
  const first = await inspect({ maxEntries: 250 });
  expect(first).toMatchObject({ data: { maxEntries: 250 } });
  expect(await inspect({ maxEntries: 250 })).toEqual(first);
  const firstPage = page(first);
  expect(firstPage.entries).toHaveLength(40);
  const seen = [...firstPage.entries];
  let cursor = firstPage.cursor;
  let pageCount = 1;
  while (cursor !== null) {
    assert(pageCount < 10, "Pagination must terminate");
    const result = await inspect({ maxEntries: 250, cursor });
    expect(await inspect({ maxEntries: 250, cursor })).toEqual(result);
    const next = page(result, seen.length);
    expect(next.entries.length).toBeGreaterThan(0);
    seen.push(...next.entries);
    cursor = next.cursor;
    pageCount += 1;
  }
  expect(seen).toEqual(expected);
  expect(new Set(seen).size).toBe(expected.length);
  expect(pageCount).toBe(3);
});

test("explicit maxEntries remains an upper bound and may change between pages", async () => {
  const { root, inspect } = await fixture();
  const expected = names(45);
  await files(root, expected);
  for (const maxEntries of [1, 7, 40, 250]) {
    const result = await inspect({ maxEntries });
    expect(result).toMatchObject({ data: { maxEntries } });
    expect(page(result).entries).toHaveLength(Math.min(maxEntries, 40));
  }
  const first = page(await inspect({ maxEntries: 1 }));
  const second = page(await inspect({ maxEntries: 7, cursor: first.cursor }), first.entries.length);
  expect([...first.entries, ...second.entries]).toEqual(expected.slice(0, 8));
});

test("preserves complete long Unicode paths and scopes dot to the request root", async () => {
  const { context, root, inspect } = await fixture();
  await files(root, ["configured-root-only.txt"]);
  const requestRoot = join(context.rootDir, "request-root");
  const directoryName = `תיקייה-${"שלום".repeat(18)}`;
  const fileName = `מסמך-${"אבגד".repeat(18)}-🙂.txt`;
  await mkdir(join(requestRoot, directoryName), { recursive: true });
  await files(join(requestRoot, directoryName), [fileName]);
  const result = await inspect({ depth: 1 }, {
    runtimePathResolver: createRuntimeToolPathResolver({
      ...context.runtimePaths, agentWorkDir: requestRoot,
    }),
  });
  expect(result).toMatchObject({ data: { target: ".", location: "agent_work" } });
  expect(page(result)).toMatchObject({
    directories: [directoryName], files: [`${directoryName}/${fileName}`], cursor: null,
  });
  expect(JSON.stringify(result)).not.toContain("configured-root-only.txt");
  expect(JSON.stringify(result)).not.toContain(requestRoot);
});

test("cursor binding distinguishes physical roots with identical logical paths and listings", async () => {
  const { context, root, inspect } = await fixture();
  const otherRoot = join(context.rootDir, "other-root");
  await mkdir(otherRoot);
  await files(root, names(45));
  await files(otherRoot, names(45));
  const first = page(await inspect({}));
  assert(first.cursor);
  failure(await inspect({ cursor: first.cursor }, {
    runtimePathResolver: createRuntimeToolPathResolver({
      ...context.runtimePaths, agentWorkDir: otherRoot,
    }),
  }), "project_cursor_query_mismatch");
});

test("rejects a cursor after the traversal depth or listing changes", async () => {
  const { root, inspect } = await fixture();
  await files(root, names(45));
  const first = page(await inspect({}));
  assert(first.cursor);
  failure(await inspect({ depth: 1, cursor: first.cursor }), "project_cursor_query_mismatch");
  await files(root, ["new-entry.txt"]);
  failure(await inspect({ cursor: first.cursor }), "project_cursor_stale");
});

test("rejects malformed and modified cursors without returning a partial listing", async () => {
  const { root, inspect } = await fixture();
  await files(root, names(45));
  const first = page(await inspect({}));
  assert(first.cursor);
  failure(await inspect({ cursor: "not-a-cursor" }), "project_cursor_invalid");
  const modified = `${first.cursor.slice(0, -1)}${first.cursor.endsWith("a") ? "b" : "a"}`;
  failure(await inspect({ cursor: modified }), "project_cursor_invalid");
});

test("the complete result stays within budget even with large manifest metadata and cursors", async () => {
  const { root, inspect } = await fixture();
  const expected = names(50).map((name) => `${"long-full-filename-".repeat(7)}${name}`);
  await files(root, expected);
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "n".repeat(256), version: "v".repeat(256), private: true,
    scripts: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [
      `${String(index).padStart(3, "0")}-${"s".repeat(28)}`, "PRIVATE_SCRIPT_BODY",
    ])),
  }));
  await files(root, ["pyproject.toml", "Cargo.toml", "go.mod", "tsconfig.json"]);
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await inspect({ maxEntries: 250, ...(cursor ? { cursor } : {}) });
    const current = page(result, seen.length);
    expect(result).toMatchObject({ data: { truncation: { manifests: true } } });
    expect(current.entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SCRIPT_BODY");
    seen.push(...current.entries);
    cursor = current.cursor;
    if (cursor === null) break;
  }
  expect(cursor).toBeNull();
  expect(new Set(seen).size).toBe(seen.length);
  expect([...seen].sort()).toEqual([
    ...expected, "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "tsconfig.json",
  ].sort());
});

test.each([
  ["long name", "n".repeat(300), "1.0.0", true],
  ["long version", "fixture", "v".repeat(300), true],
  ["both long", "n".repeat(300), "v".repeat(300), true],
  ["complete", "fixture", "1.0.0", false],
] as const)("%s manifest identity preserves omission evidence on a small complete page", async (_label, name, version, truncated) => {
  const { root, inspect } = await fixture();
  await writeFile(join(root, "package.json"), JSON.stringify({ name, version }));
  const result = await inspect({});
  expect(page(result).cursor).toBeNull();
  expect(result.data?.manifests).toEqual([{
    file: "package.json", name: name.slice(0, 256), version: version.slice(0, 256),
    scripts: [], ...(truncated ? { identityTruncated: true } : {}),
  }]);
  expect(result).toMatchObject({ data: { truncation: { manifests: truncated } } });
});

test("the complete-scan bound counts ignored entries and fails before publishing a partial page", async () => {
  const { root, inspect } = await fixture();
  await files(root, names(996));
  await Promise.all([".git", "node_modules", "dist", "coverage"].map((name) =>
    mkdir(join(root, name)),
  ));
  const withinBound = page(await inspect({}));
  expect(withinBound.entries).toHaveLength(40);
  expect(withinBound.cursor).not.toBeNull();
  expect(withinBound.directories).toEqual([]);
  await files(root, ["exceeds-scan-bound.txt"]);
  failure(await inspect({}), "project_scan_limit");
});

test("an indivisible path beyond the whole-result budget fails instead of being abbreviated", async () => {
  const { context } = await fixture();
  const target = resolvePluginPath(context, ".", {
    allowedLocations: ["agent_work", "workspace"],
  });
  const result = buildProjectInspectionPage({
    target, depth: 0, maxEntries: 40,
    listing: { entries: [{ path: "exact-path/".repeat(500), kind: "file" }], scannedEntries: 1 },
    manifests: [],
  });
  failure(result, "project_entry_exceeds_budget");
});
