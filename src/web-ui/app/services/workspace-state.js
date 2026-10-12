import { createWorkspaceStateStorage } from "./workspace-state-storage.js";
import { createServerComposerQueue } from "./server-composer-queue.js";
import { acknowledgeWorkspaceStorage, showWorkspaceStorageFailure } from "../components/workspace-storage-notice.js";
import { createStartupScreen } from "../components/startup-screen.js";

let storage;
let queue;
export const workspaceStorage = () => storage;
export const workspaceQueue = () => queue;
export function observeWorkspaceStateChange(message) {
  if (message.type !== "workspace_changed" || !message.resources?.includes("client-state")) return;
  void storage?.refresh().catch(showWorkspaceStorageFailure);
}

export async function initializeWorkspaceState() {
  storage = createWorkspaceStateStorage({ onError: showWorkspaceStorageFailure });
  try {
    await storage.refresh();
    await acknowledgeWorkspaceStorage(storage);
    queue = createServerComposerQueue(storage);
    window.addEventListener("focus", () => void storage.refresh().catch(showWorkspaceStorageFailure));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void storage.refresh().catch(showWorkspaceStorageFailure);
    });
    return storage;
  } catch (error) { createStartupScreen().fail(error); throw error; }
}
