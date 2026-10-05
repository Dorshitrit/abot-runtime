import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { syncJournalDirectory, writeJournalJson } from "../scheduler/journal-durability.js";
import type { AutomationResultRecord } from "./storage-records.js";
import type { AutomationPersistence } from "./persistence.js";

const OWNED_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/u;
const MAX_UNCOMMITTED_CLEANUP = 64;

export function createAutomationResultStore(runtimeDir: string) {
  const directory = join(runtimeDir, "automation-results");
  const activePublications = new Set<string>();
  let reconciliation: Promise<void> | undefined;

  function recordPath(record: AutomationResultRecord): string {
    const match = OWNED_FILE.exec(`${record.id}.json`);
    if (!match || record.storageRef !== `automation-results/${record.id}.json`)
      throw new Error("automation_result_ref_invalid");
    return join(directory, `${record.id}.json`);
  }

  async function save(input: {
    runId: string;
    nodeId?: string;
    kind: AutomationResultRecord["kind"];
    value: unknown;
    maxBytes: number;
    at?: string;
  }): Promise<AutomationResultRecord> {
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1)
      throw new Error("automation_artifact_budget_exhausted");
    let serialized: string;
    try { serialized = JSON.stringify(input.value); } catch {
      throw new Error("automation_output_invalid");
    }
    if (typeof serialized !== "string") throw new Error("automation_output_invalid");
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > input.maxBytes) throw new Error("automation_artifact_budget_exhausted");
    const id = randomUUID();
    const storageRef = `automation-results/${id}.json`;
    const digest = createHash("sha256").update(serialized).digest("hex");
    activePublications.add(id);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await syncJournalDirectory(dirname(directory));
      await writeJournalJson(join(directory, `${id}.json`), input.value);
    } catch (error) {
      activePublications.delete(id);
      throw error;
    }
    return {
      id,
      runId: input.runId,
      ...(input.nodeId ? { nodeId: input.nodeId } : {}),
      kind: input.kind,
      storageRef,
      digest,
      sizeBytes: bytes,
      createdAt: input.at ?? new Date().toISOString(),
    };
  }

  async function read(record: AutomationResultRecord): Promise<unknown> {
    const content = await readFile(recordPath(record), "utf8");
    const digest = createHash("sha256").update(content).digest("hex");
    if (digest !== record.digest || Buffer.byteLength(content, "utf8") !== record.sizeBytes)
      throw new Error("automation_result_corrupt");
    return JSON.parse(content) as unknown;
  }

  async function discardUncommitted(record: AutomationResultRecord): Promise<void> {
    await rm(recordPath(record), { force: true });
  }

  async function releasePublication(record: AutomationResultRecord): Promise<void> {
    recordPath(record);
    // A scan may hold a pre-commit journal snapshot. Keep this ID protected
    // until that scan finishes; subsequent scans observe the published head.
    await reconciliation?.catch(() => undefined);
    activePublications.delete(record.id);
  }

  async function reconcileFiles(persistence: AutomationPersistence): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    if (!entries.length) return;
    const state = await persistence.read();
    const committed = new Set(state.results.map((record) => record.id));
    let cleaned = 0;
    for (const entry of entries) {
      if (cleaned === MAX_UNCOMMITTED_CLEANUP) break;
      if (!entry.isFile()) continue;
      const match = OWNED_FILE.exec(entry.name);
      if (!match) continue;
      const id = match[1]!;
      if (committed.has(id) || activePublications.has(id)) continue;
      await rm(join(directory, entry.name), { force: true });
      cleaned += 1;
    }
    if (cleaned) await syncJournalDirectory(directory);
  }

  function reconcileUncommitted(persistence: AutomationPersistence): Promise<void> {
    if (reconciliation) return reconciliation;
    reconciliation = reconcileFiles(persistence).finally(() => { reconciliation = undefined; });
    return reconciliation;
  }

  return { save, read, discardUncommitted, releasePublication, reconcileUncommitted };
}

export type AutomationResultStore = ReturnType<typeof createAutomationResultStore>;
