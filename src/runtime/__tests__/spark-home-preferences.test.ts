import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createSparkHomePreferencesService, parseSparkHomePreferencesUpdate } from "../spark-home/preferences.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const base = join(process.cwd(), ".codex/artifacts/spark-home-isolated-20261102/preferences");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "case-")); roots.push(root);
  return { root, service: createSparkHomePreferencesService(root) };
}

test("HOME navigation is stored separately and survives recreation without touching workspace state", async () => {
  const f = await fixture();
  const workspace = join(f.root, "workspace-client-state.json");
  await writeFile(workspace, "UNCHANGED");
  expect(await f.service.read()).toEqual({ revision: 0, mode: "dashboard" });
  expect(await f.service.update({ expectedRevision: 0, mode: "spark_home" })).toEqual({ revision: 1, mode: "spark_home" });
  expect(await createSparkHomePreferencesService(f.root).read()).toEqual({ revision: 1, mode: "spark_home" });
  expect(await readFile(workspace, "utf8")).toBe("UNCHANGED");
});

test("competing preference updates accept one revision and preserve the winner", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([
    f.service.update({ expectedRevision: 0, mode: "spark_home" }),
    createSparkHomePreferencesService(f.root).update({ expectedRevision: 0, mode: "dashboard" }),
  ]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "spark_home_preferences_conflict" } });
  expect((await f.service.read()).revision).toBe(1);
});

test("invalid preference input or storage cannot silently reset selection", async () => {
  const f = await fixture();
  expect(() => parseSparkHomePreferencesUpdate({ expectedRevision: 0, mode: "other" })).toThrow("spark_home_preferences_invalid");
  expect(() => parseSparkHomePreferencesUpdate({ expectedRevision: 0, mode: "spark_home", extra: true })).toThrow("spark_home_preferences_invalid");
  await f.service.update({ expectedRevision: 0, mode: "spark_home" });
  await writeFile(join(f.root, "spark-home/preferences.json"), "{broken");
  await expect(f.service.read()).rejects.toThrow("spark_home_preferences_unavailable");
  await expect(f.service.update({ expectedRevision: 0, mode: "dashboard" })).rejects.toThrow("spark_home_preferences_unavailable");
});
