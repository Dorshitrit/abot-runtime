import { readFileOutputRootId } from "../../runtime/capabilities/file-output-root-identity.js";
import type { ConversationFileAccess, ConversationFileReference } from "../local-runtime/conversation-file-access.js";
import { authorizeProjectChanges, type ProjectChangesEnvironments } from "./access.js";
import type { RecordedProjectChange } from "./contracts.js";
import { readProjectFileState } from "./file-state.js";
import { isInternalProjectFile, readProjectChangesSnapshot, requireProjectChangesActive } from "./read-list.js";
import { openProjectGitRepository } from "./repository.js";
import { assertProjectChangesSnapshotCurrent } from "./service.js";

function unavailable(message = "Current project changes are unavailable for this recorded file."): RecordedProjectChange {
  return { status: "unavailable", file: null, preview: null, base: null, revision: null, message };
}
function requireRecordedRoot(directory: string, rootId: string): void {
  if (readFileOutputRootId("agent_work", directory) !== rootId)
    throw new Error("The recorded project root has changed.");
}
/** A receipt identifies the file; its preview still represents current state versus HEAD. */
export async function readRecordedProjectChange(
  environments: ProjectChangesEnvironments,
  defaultEnvironment: string,
  access: ConversationFileAccess | undefined,
  reference: ConversationFileReference,
  signal?: AbortSignal,
): Promise<RecordedProjectChange> {
  if (!access) return unavailable();
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
  try {
    const recorded = await access.authorize(reference);
    if (isInternalProjectFile(recorded.receipt.relativePath)) return unavailable();
    if (recorded.receipt.location !== "agent_work")
      return unavailable("This recorded file is outside the conversation project.");
    const authority = await authorizeProjectChanges(environments, defaultEnvironment, reference.environmentId, reference.sessionId);
    if (!authority || recorded.paths.agentWorkDir !== authority.directory) return unavailable();
    requireRecordedRoot(authority.directory, recorded.receipt.rootId);
    const before = await readProjectFileState(authority.directory, recorded.receipt.relativePath);
    const repository = await openProjectGitRepository(authority, signal);
    const snapshot = await readProjectChangesSnapshot(authority, repository, signal);
    const file = snapshot.changes.files.find((entry) => entry.path === recorded.receipt.relativePath);
    await assertProjectChangesSnapshotCurrent(authority, repository, snapshot, signal);
    const after = await readProjectFileState(authority.directory, recorded.receipt.relativePath);
    if (before.version !== after.version || before.kind !== after.kind) return unavailable("This file changed while its diff was loading. Refresh it.");
    await recorded.assertCurrent();
    await authority.assertCurrent();
    requireRecordedRoot(authority.directory, recorded.receipt.rootId);
    requireProjectChangesActive(signal);
    const base = snapshot.changes.base;
    const revision = snapshot.changes.revision;
    if (!file) {
      if (snapshot.changes.truncated)
        return { ...unavailable("This file is outside the bounded changes list."), base, revision };
      return { status: "unchanged", file: null, preview: null, base, revision, message: "This file has no current Git changes against HEAD." };
    }
    const preview = snapshot.previews.get(file.id);
    if (!preview) return unavailable();
    return { status: "available", file, preview, base, revision };
  } catch {
    return unavailable();
  }
}
