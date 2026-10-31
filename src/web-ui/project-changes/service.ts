import { authorizeProjectChanges, type ProjectChangesEnvironments, type ProjectChangesAuthority } from "./access.js";
import { ProjectChangesError, unavailableProjectChanges, type ProjectChanges, type ProjectChangePreview } from "./contracts.js";
import { readProjectFileState } from "./file-state.js";
import { readProjectAttributes } from "./normalization.js";
import { readProjectChangePatch } from "./patch.js";
import { readProjectChangesSnapshot, requireProjectChangesActive, type ProjectChangesSnapshot } from "./read-list.js";
import { openProjectGitRepository, type ProjectGitRepository } from "./repository.js";

export async function assertProjectChangesSnapshotCurrent(authority: ProjectChangesAuthority, repository: ProjectGitRepository, snapshot: ProjectChangesSnapshot, signal?: AbortSignal): Promise<void> {
  const current = await openProjectGitRepository(authority, signal);
  if (current.head !== repository.head || current.root !== repository.root || current.indexVersion !== repository.indexVersion || current.fileMode !== repository.fileMode || current.autocrlf !== repository.autocrlf || current.eol !== repository.eol)
    throw new ProjectChangesError("project_changes_stale", "Git changed while the preview was loading. Refresh project changes.", 409);
  for (const [path, before] of snapshot.versions) {
    requireProjectChangesActive(signal);
    const after = await readProjectFileState(authority.directory, path);
    if (after.version !== before.version || after.kind !== before.kind)
      throw new ProjectChangesError("project_changes_stale", "Files changed while the preview was loading. Refresh project changes.", 409);
  }
  const attributes = await readProjectAttributes(current, [...snapshot.attributes.keys()]);
  if (JSON.stringify([...attributes]) !== JSON.stringify([...snapshot.attributes]))
    throw new ProjectChangesError("project_changes_stale", "Git attributes changed. Refresh project changes.", 409);
  requireProjectChangesActive(signal);
  await authority.assertCurrent();
}

export class ProjectChangesService {
  constructor(private readonly environments: ProjectChangesEnvironments, private readonly defaultEnvironment: () => string) {}

  async list(environmentId: string, sessionId: string, signal?: AbortSignal): Promise<ProjectChanges> {
    signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
    try {
      const authority = await authorizeProjectChanges(this.environments, this.defaultEnvironment(), environmentId, sessionId);
      if (!authority) return unavailableProjectChanges("no_project", "This conversation is not attached to a project.");
      const repository = await openProjectGitRepository(authority, signal);
      const snapshot = await readProjectChangesSnapshot(authority, repository, signal);
      await assertProjectChangesSnapshotCurrent(authority, repository, snapshot, signal);
      return snapshot.changes;
    } catch (error) {
      if (error instanceof ProjectChangesError) {
        if (error.code === "project_changes_stale") throw error;
        const status = error.code === "not_git" || error.code === "git_unavailable" ? error.code : "unavailable";
        return unavailableProjectChanges(status, error.message);
      }
      return unavailableProjectChanges("unavailable", "Project changes are unavailable.");
    }
  }

  async file(environmentId: string, sessionId: string, fileId: string, revision: string, signal?: AbortSignal): Promise<ProjectChangePreview> {
    signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
    if (!/^[a-f0-9]{64}$/u.test(fileId) || !/^[a-f0-9]{64}$/u.test(revision))
      throw new ProjectChangesError("project_changes_reference_invalid", "Refresh the changes list before opening a file.");
    const authority = await authorizeProjectChanges(this.environments, this.defaultEnvironment(), environmentId, sessionId);
    if (!authority) throw new ProjectChangesError("project_changes_unavailable", "This conversation has no project.", 404);
    const repository = await openProjectGitRepository(authority, signal);
    const snapshot = await readProjectChangesSnapshot(authority, repository, signal);
    if (snapshot.changes.revision !== revision || !snapshot.previews.has(fileId))
      throw new ProjectChangesError("project_changes_stale", "Project changes have changed. Refresh the list.", 409);
    const file = readProjectChangePatch(snapshot, fileId);
    await assertProjectChangesSnapshotCurrent(authority, repository, snapshot, signal);
    const refreshedRepository = await openProjectGitRepository(authority, signal);
    const refreshed = await readProjectChangesSnapshot(authority, refreshedRepository, signal);
    await assertProjectChangesSnapshotCurrent(authority, refreshedRepository, refreshed, signal);
    if (refreshed.changes.revision !== revision)
      throw new ProjectChangesError("project_changes_stale", "Project changes have changed. Refresh the list.", 409);
    return file;
  }
}
