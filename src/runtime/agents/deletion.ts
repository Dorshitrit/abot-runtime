import { createHash } from "node:crypto";
import { assertValidSessionId } from "../../sessions/record/rules.js";
import { join } from "node:path";
import { withFileLock } from "../adapters/long-term-memory/file-lock.js";
import { ensurePrivateRuntimeDirectory } from "../local-host/private-directory.js";
import { AgentStateCommitUnknownError, type FileAgentStateStore } from "./file-store.js";
import { AgentStateError } from "./state-error.js";
import type { RuntimeAttachmentStore } from "../attachments/store.js";
import type { SessionStore } from "../ports.js";
import { deleteSessionAttachmentsIfSupported, deleteSessionWithAttachments } from "../session/session-attachment-deletion.js";

type AgentDeletionDependencies = {
  directory: string;
  store: Pick<FileAgentStateStore, "read" | "beginDeletion" | "finishDeletion" | "reconcile">;
  sessions: Pick<SessionStore, "deleteSessionWithStats" | "getSessionById" | "purgeDeletedSessionSidecars">;
  attachments: RuntimeAttachmentStore | undefined;
  removeSchedules(agentId: string): Promise<void>;
  forgetSession(sessionId: string): Promise<void>;
  forgetAgent(agentId: string): Promise<void>;
  onRecoveryError(agentId: string): void;
};

/** The canonical marker and ownership bindings outlive every external cleanup until finalization. */
export function createAgentDeletion(deps: AgentDeletionDependencies) {
  const jobs = new Map<string, Promise<void>>();
  let retired = false;

  async function clean(agentId: string, expectedRevision: number) {
    const snapshot = await deps.store.read();
    for (const { sessionId } of snapshot.sessions.filter(binding => binding.agentId === agentId)) {
      assertValidSessionId(sessionId);
      if (sessionId === ".") throw new AgentStateError("agents_deletion_unresolved");
      const session = await deps.sessions.getSessionById(sessionId);
      if (session?.requests?.some(request => request.status === "streaming" || request.status === "awaiting_approval"))
        throw new AgentStateError("agents_deletion_unresolved");
    }
    const state = await deps.store.beginDeletion(agentId, expectedRevision);
    if (!state.deletingAgentIds.includes(agentId)) return;
    try {
      await deps.removeSchedules(agentId);
      for (const binding of state.sessions.filter(session => session.agentId === agentId)) {
        const { sessionId } = binding;
        const receipt = await deleteSessionWithAttachments(deps.sessions, deps.attachments, sessionId);
        // A binding can precede a transcript, or the process can stop after its unlink.
        if (!receipt.deleted) await deleteSessionAttachmentsIfSupported(deps.attachments, sessionId);
        await deps.sessions.purgeDeletedSessionSidecars?.(sessionId);
        await deps.forgetSession(sessionId);
      }
      await deps.forgetAgent(agentId);
      await deps.store.finishDeletion(agentId);
    } catch (error) {
      if (error instanceof AgentStateCommitUnknownError) throw error;
      throw new AgentStateError("agents_deletion_cleanup_failed", { cause: error });
    }
  }

  async function run(agentId: string, expectedRevision: number) {
    await ensurePrivateRuntimeDirectory(deps.directory);
    const key = createHash("sha256").update(agentId).digest("hex");
    // A second process must re-read ownership after the first caller completes.
    await withFileLock(join(deps.directory, `delete-${key}.lock`), async () => {
      try { await clean(agentId, expectedRevision); }
      catch (error) {
        if (!(error instanceof AgentStateCommitUnknownError)) throw error;
        await deps.store.reconcile();
        throw new AgentStateError("agents_deletion_cleanup_failed", { cause: error });
      }
    });
  }

  function remove(agentId: string, expectedRevision: number): Promise<void> {
    if (retired) return Promise.reject(new AgentStateError("agents_environment_reloading"));
    const existing = jobs.get(agentId);
    if (existing) return existing;
    const job = run(agentId, expectedRevision).finally(() => jobs.delete(agentId));
    jobs.set(agentId, job);
    return job;
  }

  async function recover() {
    const { revision, deletingAgentIds } = await deps.store.read();
    for (const agentId of deletingAgentIds) {
      try { await remove(agentId, revision); }
      catch { deps.onRecoveryError(agentId); }
    }
  }

  return { remove, recover, isBusy: () => jobs.size > 0,
    async stop() { retired = true; await Promise.allSettled(jobs.values()); } };
}
