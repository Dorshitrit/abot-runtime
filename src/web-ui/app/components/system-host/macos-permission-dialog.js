/** An explanation before the existing collection action can ask macOS for consent. */
export function createMacPermissionDialog({
  container,
  copyText = (value) => navigator.clipboard.writeText(value),
}) {
  const documentRoot = container.ownerDocument;
  const dialog = documentRoot.createElement("dialog");
  dialog.className = "mac-permission-dialog";
  dialog.setAttribute("aria-labelledby", "macPermissionTitle");
  dialog.setAttribute("aria-describedby", "macPermissionDescription");
  dialog.innerHTML = `<div class="mac-permission-content">
    <div class="mac-permission-top"><span class="mac-permission-icon" aria-hidden="true">⌘</span>
      <button type="button" class="mac-permission-close" data-mac-permission-cancel aria-label="Cancel and close">×</button></div>
    <p class="mac-permission-eyebrow">Computer access · macOS</p>
    <h2 id="macPermissionTitle" tabindex="-1">Before you enable Spark</h2>
    <p class="mac-permission-lead">macOS will show <strong>“node”</strong>.</p>
    <p id="macPermissionDescription" class="mac-permission-description">That is the executable used by ABot’s computer companion. Check the path below to identify ABot’s copy before allowing access.</p>
    <div class="mac-permission-identity">
      <p>ABot’s companion executable on the connected Mac</p>
      <div class="mac-permission-path"><code data-mac-permission-path tabindex="0"></code>
        <button type="button" data-mac-permission-copy aria-label="Copy companion executable path">Copy path</button></div>
      <p class="mac-permission-path-note">Other apps also use node. Allow the entry for this exact path.</p>
    </div>
    <p class="mac-permission-usage">Spark uses Accessibility to read activity that your apps make accessible. <strong>Spark collects only while collection is enabled.</strong></p>
    <details class="mac-permission-details"><summary>What you are allowing</summary>
      <p><strong>Accessibility is an operating-system permission.</strong> It can allow this executable to read accessible app content and interact with your computer.</p>
      <p>Turning Spark collection off stops collection, but keeps the macOS permission. Revoke it anytime in <strong>System Settings → Privacy &amp; Security → Accessibility</strong>.</p>
      <p>Some app content may remain unavailable. Screen capture or other actions may need separate permission. An update may require your consent again.</p>
    </details>
    <p class="mac-permission-feedback" data-mac-permission-feedback role="status" aria-live="polite"></p>
  </div>
  <div class="mac-permission-footer"><span>Next: macOS permission step, if needed</span>
    <div><button type="button" data-mac-permission-cancel>Cancel</button>
      <button type="button" class="mac-permission-continue" data-mac-permission-continue>Continue →</button></div>
  </div>`;
  (documentRoot.body ?? container).append(dialog);
  const pathElement = dialog.querySelector("[data-mac-permission-path]");
  const feedback = dialog.querySelector("[data-mac-permission-feedback]");
  const copy = dialog.querySelector("[data-mac-permission-copy]");
  let pending;
  let returnFocus;

  function finish(approved) {
    if (!pending) return;
    const resolve = pending;
    pending = undefined;
    dialog.close();
    if (returnFocus?.isConnected && !returnFocus.closest("[hidden]"))
      returnFocus.focus();
    resolve(approved);
  }
  for (const button of dialog.querySelectorAll("[data-mac-permission-cancel]"))
    button.addEventListener("click", () => finish(false));
  dialog
    .querySelector("[data-mac-permission-continue]")
    .addEventListener("click", () => finish(true));
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    finish(false);
  });
  dialog.addEventListener("close", () => finish(false));
  copy.addEventListener("click", async () => {
    try {
      await copyText(pathElement.textContent);
      feedback.textContent = "Companion path copied.";
      copy.textContent = "Copied";
    } catch {
      feedback.textContent =
        "Copy is unavailable. Select the path and use your copy shortcut.";
      pathElement.focus();
    }
  });
  return {
    confirm(path) {
      if (pending) return Promise.resolve(false);
      pathElement.textContent = path;
      feedback.textContent = "";
      copy.textContent = "Copy path";
      dialog.querySelector("details").open = false;
      returnFocus = documentRoot.activeElement;
      return new Promise((resolve) => {
        pending = resolve;
        dialog.showModal();
        dialog.querySelector("h2").focus();
      });
    },
    cancel() {
      finish(false);
    },
    dispose() {
      finish(false);
      dialog.remove();
    },
  };
}
