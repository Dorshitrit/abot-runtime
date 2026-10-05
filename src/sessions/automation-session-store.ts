import { readdir } from "node:fs/promises";
import { AutomationSessionLockedError, hasAutomationSessionOrigin, isAutomationSessionOrigin,
  type AutomationSessionHandle, type AutomationSessionOrigin,
  type createAutomationSessionAccess } from "./automation-session-origin.js";
import { assertValidSessionId } from "./record/rules.js";
import { saveDurableSessionFile } from "./durable-session-commit.js";
import { deleteSessionFile, ensureSessionsDir, loadSessionFile } from "./session-store.js";

const MAX_SESSION_RETIREMENTS = 64;
const MAX_SESSION_SCANS = 256;

/** Adapter-owned lifetime and recovery for hidden attempt transcripts only. */
export function createAutomationSessionStore(input: {
  sessionsDir: string;
  now(): Date;
  access: ReturnType<typeof createAutomationSessionAccess>;
  enqueue<T>(sessionId: string, mutation: () => Promise<T>): Promise<T>;
}) {
  const handles = new WeakMap<AutomationSessionHandle, string>();
  const owners = new Map<string, number>();
  const retiring = new Set<string>();
  let cursor = "";
  let reconciliation: Promise<void> | undefined;

  function releaseOwner(sessionId: string): void {
    const remaining = (owners.get(sessionId) ?? 1) - 1;
    if (remaining > 0) { owners.set(sessionId, remaining); return; }
    owners.delete(sessionId);
  }

  async function create(sessionId: string, origin: AutomationSessionOrigin): Promise<AutomationSessionHandle> {
    assertValidSessionId(sessionId);
    if (!isAutomationSessionOrigin(origin)) throw new Error("automation_session_origin_invalid");
    if (retiring.has(sessionId)) throw new AutomationSessionLockedError();
    const handle = input.access.issue(sessionId, origin);
    owners.set(sessionId, (owners.get(sessionId) ?? 0) + 1);
    try {
      await input.access.run(handle, () => input.enqueue(sessionId, async () => {
        await ensureSessionsDir(input.sessionsDir);
        const existing = await loadSessionFile(input.sessionsDir, sessionId);
        if (existing && !hasAutomationSessionOrigin(existing))
          throw new Error("automation_session_origin_conflict");
        if (existing) return;
        const timestamp = input.now().toISOString();
        await saveDurableSessionFile(input.sessionsDir, {
          id: sessionId, automationOrigin: Object.freeze({ ...origin }), title: sessionId,
          createdAt: timestamp, updatedAt: timestamp, lastAgentMode: "reasoning",
          messageCount: 0, messages: [],
        });
      }));
      handles.set(handle, sessionId);
      return handle;
    } catch (error) {
      input.access.revoke(handle);
      releaseOwner(sessionId);
      throw error;
    }
  }

  function release(handle: AutomationSessionHandle): void {
    const sessionId = handles.get(handle);
    if (!sessionId) return;
    handles.delete(handle);
    input.access.revoke(handle);
    releaseOwner(sessionId);
  }

  async function retire(sessionId: string, origin: AutomationSessionOrigin,
    cleanupAttachments: (id: string) => Promise<void>): Promise<void> {
    // Claim synchronously before issuing recovery authority or awaiting storage.
    if (owners.has(sessionId)) return;
    retiring.add(sessionId);
    const handle = input.access.issue(sessionId, origin);
    try {
      await input.access.run(handle, () => input.enqueue(sessionId, async () => {
        const current = await loadSessionFile(input.sessionsDir, sessionId);
        if (!current || current.id !== sessionId) return;
        if (!isAutomationSessionOrigin(current.automationOrigin)) return;
        input.access.assertAccess(sessionId, current);
        // Keep the durable origin until its dependent cleanup succeeds.
        await cleanupAttachments(sessionId);
        await deleteSessionFile(input.sessionsDir, sessionId);
      }));
    } finally {
      input.access.revoke(handle);
      retiring.delete(sessionId);
    }
  }

  async function reconcileFiles(cleanupAttachments: (id: string) => Promise<void>,
    onError: (sessionId: string, error: unknown) => void): Promise<void> {
    await ensureSessionsDir(input.sessionsDir);
    const entries = await readdir(input.sessionsDir, { withFileTypes: true });
    const names = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name).sort();
    const ordered = [...names.filter((name) => name > cursor), ...names.filter((name) => name <= cursor)];
    let attempted = 0;
    let scanned = 0;
    for (const name of ordered) {
      if (attempted === MAX_SESSION_RETIREMENTS) break;
      if (scanned === MAX_SESSION_SCANS) break;
      scanned += 1;
      cursor = name;
      const sessionId = name.slice(0, -5);
      if (owners.has(sessionId)) continue;
      try {
        assertValidSessionId(sessionId);
        const session = await loadSessionFile(input.sessionsDir, sessionId);
        if (!session || session.id !== sessionId) continue;
        if (!isAutomationSessionOrigin(session.automationOrigin)) continue;
        attempted += 1;
        await retire(sessionId, session.automationOrigin, cleanupAttachments);
      } catch (error) {
        // Advancing the cursor also for failures keeps later bounded batches fair.
        onError(sessionId, error);
      }
    }
  }

  function reconcile(cleanupAttachments: (id: string) => Promise<void>,
    onError: (sessionId: string, error: unknown) => void): Promise<void> {
    if (reconciliation) return reconciliation;
    reconciliation = reconcileFiles(cleanupAttachments, onError)
      .finally(() => { reconciliation = undefined; });
    return reconciliation;
  }

  return { create, release, reconcile };
}
