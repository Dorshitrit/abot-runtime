import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createSparkHomeService } from "../spark-home/store.js";
import { SPARK_HOME_MAX_HTML_BYTES } from "../spark-home/contracts.js";

const io = vi.hoisted(() => ({ failRename: false }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    if (io.failRename) throw new Error("simulated_atomic_replace_failure");
    return actual.rename(...args);
  } };
});
const roots: string[] = [];
const html = '<!doctype html><html lang="he"><style>body{color:blue}</style><p>שלום</p><script>let x = 1;</script></html>';
afterEach(async () => {
  io.failRename = false;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const base = join(process.cwd(), ".codex/artifacts");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "spark-home-store-")); roots.push(root);
  return { root, service: createSparkHomeService(root), file: join(root, "spark-home/screen.json") };
}

test("missing screen is empty without writing and saved HTML survives restart in exactly one environment", async () => {
  const f = await fixture();
  expect(await f.service.read()).toEqual({ revision: 0, html: null, updatedAt: null });
  expect(await readdir(f.root)).toEqual([]);
  const saved = await f.service.update({ expectedRevision: 0, html });
  expect(saved).toEqual({ revision: 1, html, updatedAt: expect.any(String) });
  expect(await createSparkHomeService(f.root).read()).toEqual(saved);
  expect(await createSparkHomeService(join(f.root, "another-environment")).read())
    .toEqual({ revision: 0, html: null, updatedAt: null });
  expect(JSON.parse(await readFile(f.file, "utf8"))).toEqual({ schemaVersion: 1, ...saved });
});

test("exact-revision replacement preserves the previous screen on stale writes", async () => {
  const f = await fixture();
  await f.service.update({ expectedRevision: 0, html });
  const next = await f.service.update({ expectedRevision: 1, html: "<p>Next</p>" });
  const before = await readFile(f.file, "utf8");
  await expect(f.service.update({ expectedRevision: 1, html: "<p>Stale</p>" }))
    .rejects.toThrow("spark_home_revision_conflict");
  expect(await readFile(f.file, "utf8")).toBe(before);
  expect(await f.service.read()).toEqual(next);
});

test("independent owners serialize competing updates and accept exactly one revision", async () => {
  const f = await fixture();
  const other = createSparkHomeService(f.root);
  const results = await Promise.allSettled([
    f.service.update({ expectedRevision: 0, html: "<p>First</p>" }),
    other.update({ expectedRevision: 0, html: "<p>Second</p>" }),
  ]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.find(result => result.status === "rejected")).toMatchObject({
    reason: { code: "spark_home_revision_conflict" },
  });
  expect((await f.service.read()).revision).toBe(1);
  expect(await other.read()).toEqual(await f.service.read());
});

test("atomic replacement failure leaves the previous bytes and removes the temporary file", async () => {
  const f = await fixture();
  await f.service.update({ expectedRevision: 0, html });
  const before = await readFile(f.file, "utf8");
  io.failRename = true;
  await expect(f.service.update({ expectedRevision: 1, html: "<p>Failed</p>" }))
    .rejects.toThrow("spark_home_storage_unavailable");
  expect(await readFile(f.file, "utf8")).toBe(before);
  expect(await readdir(join(f.root, "spark-home"))).toEqual(["screen.json"]);
});

test.each([
  { expectedRevision: -1, html }, { expectedRevision: 1.5, html },
  { expectedRevision: 1, html: "" }, { expectedRevision: 1, html: "  " },
  { expectedRevision: 1, html: "א".repeat(SPARK_HOME_MAX_HTML_BYTES / 2 + 1) },
])("invalid or oversized input preserves the current screen", async (input) => {
  const f = await fixture();
  await f.service.update({ expectedRevision: 0, html });
  const before = await readFile(f.file, "utf8");
  await expect(f.service.update(input)).rejects.toThrow();
  expect(await readFile(f.file, "utf8")).toBe(before);
});

test("the HTML limit counts UTF-8 bytes and accepts its exact boundary", async () => {
  const f = await fixture();
  const exact = "א".repeat(SPARK_HOME_MAX_HTML_BYTES / 2);
  expect((await f.service.update({ expectedRevision: 0, html: exact })).html).toBe(exact);
});

test.each(["{broken", JSON.stringify({ schemaVersion: 8, revision: 1, html, updatedAt: new Date().toISOString() })])
("invalid stored state fails read and cannot be overwritten as an empty screen", async (corrupt) => {
  const f = await fixture();
  await f.service.update({ expectedRevision: 0, html });
  await writeFile(f.file, corrupt);
  await expect(f.service.read()).rejects.toThrow("spark_home_storage_invalid");
  await expect(f.service.update({ expectedRevision: 0, html })).rejects.toThrow("spark_home_storage_invalid");
  expect(await readFile(f.file, "utf8")).toBe(corrupt);
});
