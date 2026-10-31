import { ProjectChangesError, type ProjectChangePreview } from "./contracts.js";
import type { ProjectChangesSnapshot } from "./read-list.js";

export function readProjectChangePatch(snapshot: ProjectChangesSnapshot, fileId: string): ProjectChangePreview {
  const preview = snapshot.previews.get(fileId);
  if (!preview) throw new ProjectChangesError("project_changes_stale", "This file is no longer in the current changes. Refresh the list.", 409);
  return preview;
}
