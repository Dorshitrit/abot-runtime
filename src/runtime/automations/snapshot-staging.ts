import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeAttachmentStore } from "../attachments/store.js";
import { syncJournalDirectory, syncJournalDirectoryPath, writeJournalJson } from "../scheduler/journal-durability.js";
import type { AutomationPersistence } from "./persistence.js";
import type { AutomationJournalState } from "./storage-records.js";

const MAX_STAGED_CLEANUP = 64;
const MARKER_KIND = "automation_snapshot_preparation_v1";
const SAFE_OWNER = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/u;

function requireSnapshotOwner(runId: string): void {
  if (!SAFE_OWNER.test(runId)) throw new Error("automation_snapshot_owner_invalid");
}

function hasCommittedSnapshotOwner(state: AutomationJournalState, runId: string): boolean {
  if (state.executions.some((execution) => execution.id === runId)) return true;
  return state.inputs.some((record) =>
    record.snapshot?.attachment.storageRef.split(/[\\/]/u)[0] === runId);
}

/** Only explicit durable preparation markers authorize orphan cleanup in the shared attachment store. */
export function createAutomationSnapshotStaging(options: {
  runtimeDir: string;
  persistence: AutomationPersistence;
  attachments: RuntimeAttachmentStore;
}) {
  const directory = join(options.runtimeDir, "automation-snapshot-preparations");
  const active = new Set<string>();
  let reconciliation: Promise<void> | undefined;

  async function removeMarker(runId: string): Promise<void> {
    await rm(join(directory, `${runId}.json`), { force: true });
    await syncJournalDirectory(directory);
  }

  async function begin(runId: string): Promise<void> {
    requireSnapshotOwner(runId);
    if (active.has(runId)) throw new Error("automation_snapshot_preparation_active");
    active.add(runId);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await syncJournalDirectoryPath(directory);
      await writeJournalJson(join(directory, `${runId}.json`), { kind: MARKER_KIND, runId });
    } catch (error) {
      active.delete(runId);
      throw error;
    }
  }

  async function discard(runId: string): Promise<void> {
    requireSnapshotOwner(runId);
    try {
      // Keep the active owner until an older reconciliation has finished with
      // its pre-claim journal snapshot. New readers observe the settled claim.
      await reconciliation?.catch(() => undefined);
      const state = await options.persistence.read().catch(() => undefined);
      // A publication sync failure may hide a committed claim from this process.
      // Preserve its marker and bytes for recovery instead of masking that error.
      if (!state) return;
      const committed = hasCommittedSnapshotOwner(state, runId);
      if (!committed) await options.attachments.deleteSessionAttachments(runId);
      // begin may have failed before creating the marker directory.
      await removeMarker(runId).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    } finally {
      active.delete(runId);
    }
  }

  async function discardAbandonedMarkerWrite(name: string): Promise<boolean> {
    const temporary = /^([A-Za-z0-9_-][A-Za-z0-9._-]*)\.json\.[0-9a-f-]{36}\.tmp$/u.exec(name);
    if (!temporary) return false;
    if (active.has(temporary[1]!)) return false;
    await rm(join(directory, name), { force: true });
    return true;
  }

  async function reconcileMarkers(): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    if (!entries.length) return;
    const state = await options.persistence.read();
    let cleaned = 0;
    for (const entry of entries) {
      if (cleaned === MAX_STAGED_CLEANUP) break;
      if (!entry.isFile()) continue;
      const discardedTemporary = await discardAbandonedMarkerWrite(entry.name);
      if (discardedTemporary) {
        cleaned += 1;
        continue;
      }
      if (!entry.name.endsWith(".json")) continue;
      const runId = entry.name.slice(0, -5);
      requireSnapshotOwner(runId);
      const content = await readFile(join(directory, entry.name), "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (content === undefined) continue;
      const marker = JSON.parse(content) as Record<string, unknown>;
      const isOwnedMarker = marker?.kind === MARKER_KIND && marker.runId === runId;
      if (!isOwnedMarker) throw new Error("automation_snapshot_marker_invalid");
      const committed = hasCommittedSnapshotOwner(state, runId);
      const preparationStillActive = !committed && active.has(runId);
      if (preparationStillActive) continue;
      if (!committed) await options.attachments.deleteSessionAttachments(runId);
      await removeMarker(runId);
      active.delete(runId);
      cleaned += 1;
    }
  }

  function reconcile(): Promise<void> {
    if (reconciliation) return reconciliation;
    reconciliation = reconcileMarkers().finally(() => { reconciliation = undefined; });
    return reconciliation;
  }

  return { begin, discard, reconcile };
}

export type AutomationSnapshotStaging = ReturnType<typeof createAutomationSnapshotStaging>;
