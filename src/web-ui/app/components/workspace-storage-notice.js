export async function acknowledgeWorkspaceStorage(storage, documentRoot = document) {
  if (storage.snapshot().introductionSeen) return;
  const dialog = documentRoot.createElement("dialog");
  dialog.className = "workspace-storage-notice";
  dialog.innerHTML = `<h2>Your workspace settings stay with ABot</h2>
    <p>Settings and queued messages are now saved with this ABot installation, across browsers and app restarts.</p>
    <p>This is a one-time fresh start. Previous browser-only pins, archives, model choices, memory review markers and queued messages are not imported.</p>
    <p>Your conversations, memories, configuration and read status are kept. Tool permissions start in <strong>Ask</strong>; you can change them in the composer.</p>
    <p role="alert" hidden></p><button type="button" class="primary">Continue</button>`;
  documentRoot.body.append(dialog);
  dialog.addEventListener("cancel", (event) => event.preventDefault());
  dialog.showModal();
  await new Promise((resolve) => {
    const button = dialog.querySelector("button");
    button.addEventListener("click", async () => {
      button.disabled = true;
      try { await storage.execute({ kind: "introduction" }); dialog.close(); dialog.remove(); resolve(); }
      catch (error) {
        const notice = dialog.querySelector('[role="alert"]');
        notice.textContent = `${error.message} Reload to try again.`;
        notice.hidden = false;
      }
    });
  });
}

export function showWorkspaceStorageFailure(error, documentRoot = document) {
  let notice = documentRoot.querySelector("[data-workspace-storage-error]");
  if (!notice) {
    notice = documentRoot.createElement("div");
    notice.dataset.workspaceStorageError = "";
    notice.setAttribute("role", "alert");
    notice.className = "workspace-storage-failure";
    documentRoot.body.append(notice);
  }
  notice.textContent = `${error.message} Changes are not confirmed. Reload before sending more messages.`;
}
