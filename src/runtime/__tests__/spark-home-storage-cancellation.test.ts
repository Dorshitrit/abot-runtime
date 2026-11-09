import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { acquireFileLock } from "../adapters/long-term-memory/file-lock/acquisition.js";
import { createSparkHomeService } from "../spark-home/store.js";
import { createSparkHomeGenerationService } from "../spark-home/generation/service.js";
import { createHomeGenerationFixture, deferred } from "./support/spark-home-generation-fixture.js";
import { disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";

const io = vi.hoisted(() => ({ lockPath: "", contended: undefined as (() => void) | undefined,
  temporaryClosed: undefined as ((path: string) => Promise<void>) | undefined }));
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof fs>();
  return { ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      try { return await actual.mkdir(...args); }
      catch (error) {
        if (String(args[0]) === io.lockPath && (error as { code?: string }).code === "EEXIST") io.contended?.();
        throw error;
      }
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (String(args[0]).includes("screen.json.") && String(args[0]).endsWith(".tmp")) {
        const close = handle.close.bind(handle);
        handle.close = async () => { await close(); await io.temporaryClosed?.(String(args[0])); };
      }
      return handle;
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  io.lockPath = ""; io.contended = undefined; io.temporaryClosed = undefined;
  await disposeCompositionFixtures();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function storageFixture() {
  const base = join(process.cwd(), ".codex/artifacts/spark-home-review-339-20261102");
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(join(base, "storage-cancellation-")); roots.push(root);
  const screen = createSparkHomeService(root);
  const directory = join(root, "spark-home");
  return { root, screen, directory, file: join(directory, "screen.json"), lockPath: join(directory, "screen.lock") };
}

test("an already cancelled screen update preserves the abort reason and performs no storage writes", async () => {
  const f = await storageFixture();
  const abort = new AbortController();
  const reason = new Error("cancelled_before_storage");
  abort.abort(reason);
  await expect(f.screen.update({ expectedRevision: 0, html: "<p>Cancelled</p>" }, { abortSignal: abort.signal }))
    .rejects.toBe(reason);
  expect(await fs.readdir(f.root)).toEqual([]);
});

test.each(["cancel", "stop"])("%s while waiting for the real screen lock cannot publish the generated page", async command => {
  const f = await storageFixture();
  const previous = await f.screen.update({ expectedRevision: 0, html: "<p>Previous page</p>" });
  const bytes = await fs.readFile(f.file, "utf8");
  const fixture = await createHomeGenerationFixture();
  const generation = createSparkHomeGenerationService({ ...fixture.dependencies, screen: f.screen });
  const statuses: string[] = [];
  generation.subscribe(snapshot => { statuses.push(snapshot.status); });
  const release = await acquireFileLock(f.lockPath, {});
  const waiting = deferred<void>();
  io.lockPath = f.lockPath; io.contended = () => waiting.resolve();
  try {
    const run = await generation.start({ expectedSettingsRevision: 1 });
    await waiting.promise;
    const cancellation = command === "cancel" ? generation.cancel({ runId: run.runId }) : generation.stop();
    expect(await fs.readFile(f.file, "utf8")).toBe(bytes);
    await release();
    await cancellation;
    expect(await generation.wait(run.runId)).toMatchObject({
      status: command === "cancel" ? "cancelled" : "interrupted", screenRevision: null,
      errorCode: command === "cancel" ? "spark_home_run_cancelled" : "spark_home_run_interrupted",
    });
    expect(statuses).not.toContain("completed");
    expect(await f.screen.read()).toEqual(previous);
    expect(await fs.readFile(f.file, "utf8")).toBe(bytes);
    expect(await fs.readdir(f.directory)).toEqual(["screen.json"]);
  } finally { await release(); await generation.stop(); }
});

test("cancellation after the temporary file closes leaves old bytes, cleans up, and allows the next exact-revision update", async () => {
  const f = await storageFixture();
  const previous = await f.screen.update({ expectedRevision: 0, html: "<p>Previous page</p>" });
  const bytes = await fs.readFile(f.file, "utf8");
  const abort = new AbortController();
  const reason = new Error("cancelled_after_temporary_write");
  let closedTemporaryObserved = false;
  io.temporaryClosed = async path => {
    expect(JSON.parse(await fs.readFile(path, "utf8"))).toMatchObject({ revision: 2, html: "<p>Cancelled page</p>" });
    closedTemporaryObserved = true;
    abort.abort(reason);
  };
  await expect(f.screen.update({ expectedRevision: 1, html: "<p>Cancelled page</p>" }, { abortSignal: abort.signal }))
    .rejects.toBe(reason);
  expect(closedTemporaryObserved).toBe(true);
  expect(await f.screen.read()).toEqual(previous);
  expect(await fs.readFile(f.file, "utf8")).toBe(bytes);
  expect(await fs.readdir(f.directory)).toEqual(["screen.json"]);
  io.temporaryClosed = undefined;
  const saved = await f.screen.update({ expectedRevision: 1, html: "<p>Accepted page</p>" }, { abortSignal: new AbortController().signal });
  expect(saved).toMatchObject({ revision: 2, html: "<p>Accepted page</p>" });
  expect(JSON.parse(await fs.readFile(f.file, "utf8"))).toEqual({ schemaVersion: 1, ...saved });
  await expect(f.screen.update({ expectedRevision: 1, html: "<p>Stale page</p>" }))
    .rejects.toThrow("spark_home_revision_conflict");
  expect(await f.screen.read()).toEqual(saved);
});
