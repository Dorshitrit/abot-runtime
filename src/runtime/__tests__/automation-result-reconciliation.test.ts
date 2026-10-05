import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createAutomationResultStore } from "../automations/result-store.js";
import { publishAutomationResult } from "../automations/result-publication.js";
import { emptyAutomationJournalState } from "../automations/storage-records.js";
import type { AutomationPersistence } from "../automations/persistence.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "automation-result-reconciliation-"));
  roots.push(root);
  const results = createAutomationResultStore(root);
  const state = emptyAutomationJournalState();
  const persistence = { read: vi.fn(async () => structuredClone(state)) } as unknown as AutomationPersistence;
  const save = () => results.save({ runId: "run", nodeId: "step", kind: "node_output",
    value: { text: "Preserve this output." }, maxBytes: 1024 });
  return { root, results, state, persistence, save };
}

test("maintenance protects an in-flight saved result; restart reclaims its abandoned file", async () => {
  const f = await fixture();
  const record = await f.save();
  await f.results.reconcileUncommitted(f.persistence);
  await expect(f.results.read(record)).resolves.toEqual({ text: "Preserve this output." });
  await createAutomationResultStore(f.root).reconcileUncommitted(f.persistence);
  await expect(f.results.read(record)).rejects.toMatchObject({ code: "ENOENT" });
});

test("publication release waits a stale pre-commit scan before dropping active protection", async () => {
  const f = await fixture();
  const record = await f.save();
  const readStarted = deferred<void>();
  const resumeRead = deferred<void>();
  vi.mocked(f.persistence.read).mockImplementationOnce(async () => {
    const stale = structuredClone(f.state);
    readStarted.resolve();
    await resumeRead.promise;
    return stale;
  });
  const scan = f.results.reconcileUncommitted(f.persistence);
  await readStarted.promise;
  let published = false;
  const publication = publishAutomationResult({ ...f, record,
    publish: async () => { f.state.results.push(record); },
  }).then(() => { published = true; });
  await Promise.resolve();
  expect(published).toBe(false);
  resumeRead.resolve();
  await Promise.all([scan, publication]);
  await f.results.reconcileUncommitted(f.persistence);
  await expect(f.results.read(record)).resolves.toEqual({ text: "Preserve this output." });
});

test("concurrent maintenance shares a single scan and its durable journal read", async () => {
  const f = await fixture();
  await f.save();
  const recovered = createAutomationResultStore(f.root);
  const gate = deferred<void>();
  vi.mocked(f.persistence.read).mockImplementation(async () => {
    await gate.promise;
    return structuredClone(f.state);
  });
  const first = recovered.reconcileUncommitted(f.persistence);
  const second = recovered.reconcileUncommitted(f.persistence);
  expect(second).toBe(first);
  gate.resolve();
  await first;
  expect(f.persistence.read).toHaveBeenCalledOnce();
});

test("an unreadable journal never authorizes orphan removal; accepted old head later reclaims it", async () => {
  const f = await fixture();
  const record = await f.save();
  const failure = new Error("uncertain_publication");
  vi.mocked(f.persistence.read).mockRejectedValue(failure);
  await expect(publishAutomationResult({ ...f, record,
    publish: async () => { throw failure; },
  })).rejects.toBe(failure);
  await expect(f.results.reconcileUncommitted(f.persistence)).rejects.toBe(failure);
  await expect(f.results.read(record)).resolves.toBeDefined();
  vi.mocked(f.persistence.read).mockResolvedValue(f.state);
  await f.results.reconcileUncommitted(f.persistence);
  await expect(f.results.read(record)).rejects.toMatchObject({ code: "ENOENT" });
});

test("a readable committed record survives an error reported after publication", async () => {
  const f = await fixture();
  const record = await f.save();
  const failure = new Error("post_commit_observer_failed");
  await expect(publishAutomationResult({ ...f, record, publish: async () => {
    f.state.results.push(record); throw failure;
  } })).rejects.toBe(failure);
  await f.results.reconcileUncommitted(f.persistence);
  await expect(f.results.read(record)).resolves.toBeDefined();
});

test("cleanup is bounded to64 owned UUID files and ignores unknown names and symlinks", async () => {
  const f = await fixture();
  const committed = await f.save();
  f.state.results.push(committed);
  const directory = join(f.root, "automation-results");
  const orphanNames = Array.from({ length: 65 }, () => `${randomUUID()}.json`);
  await Promise.all(orphanNames.map((name) => writeFile(join(directory, name), "{}")));
  const foreignNames = ["notes.json", "------------------------------------.json", "in-progress.json.tmp"];
  await Promise.all(foreignNames.map((name) => writeFile(join(directory, name), "User-owned bytes.")));
  const linkName = `${randomUUID()}.json`;
  await symlink(join(directory, foreignNames[0]!), join(directory, linkName));
  const recovered = createAutomationResultStore(f.root);
  await recovered.reconcileUncommitted(f.persistence);
  const remaining = await readdir(directory);
  expect(remaining.filter((name) => orphanNames.includes(name))).toHaveLength(1);
  expect(remaining).toEqual(expect.arrayContaining([...foreignNames, linkName]));
  await recovered.reconcileUncommitted(f.persistence);
  expect((await readdir(directory)).filter((name) => orphanNames.includes(name))).toEqual([]);
  await expect(f.results.read(committed)).resolves.toBeDefined();
  expect(await readFile(join(directory, foreignNames[0]!), "utf8")).toBe("User-owned bytes.");
});

test("record path validation prevents forged ID or storageRef cleanup outside the owned file", async () => {
  const f = await fixture();
  const record = await f.save();
  for (const forged of [{ ...record, id: "../outside" },
    { ...record, storageRef: "../outside.json" }, { ...record, id: randomUUID() }]) {
    await expect(f.results.discardUncommitted(forged)).rejects.toThrow("automation_result_ref_invalid");
    await expect(f.results.releasePublication(forged)).rejects.toThrow("automation_result_ref_invalid");
  }
  await expect(f.results.read(record)).resolves.toBeDefined();
});
