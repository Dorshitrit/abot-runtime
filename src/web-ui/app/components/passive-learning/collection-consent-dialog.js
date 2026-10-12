/** One explicit, initially unchecked acknowledgment before saving installation consent. */
export function createCollectionConsentDialog({ container }) {
  const documentRoot = container.ownerDocument;
  const dialog = documentRoot.createElement("dialog");
  dialog.className = "mac-permission-dialog collection-consent-dialog";
  dialog.setAttribute("aria-labelledby", "collectionConsentTitle");
  dialog.setAttribute("aria-describedby", "collectionConsentDescription");
  dialog.innerHTML = `<div class="mac-permission-content">
    <div class="mac-permission-top"><span class="mac-permission-eyebrow">ABot Spark · Activity collection</span>
      <button type="button" class="mac-permission-close" data-collection-consent-cancel aria-label="Cancel and close">×</button></div>
    <h2 id="collectionConsentTitle" tabindex="-1">Before allowing activity collection</h2>
    <p id="collectionConsentDescription" class="mac-permission-description">Spark can read accessible text and activity from your applications, including window titles and URLs. This may include personal or sensitive information.</p>
    <p class="mac-permission-usage">When learning is enabled, collected content is sent to your selected learning model. A remote model provider receives that content outside this computer.</p>
    <p class="mac-permission-usage">Collection and learning have separate controls. You can stop collection, exclude applications, or delete pending activity in Spark. Stopping collection does not recall content already sent to model providers. Saving this acknowledgment alone does not start collection.</p>
    <p class="mac-permission-path-note">This acknowledgment is saved for this ABot installation and kept across updates.</p>
    <label class="collection-consent-acknowledgment"><input type="checkbox" data-collection-consent-acknowledged />
      <span>I understand and agree to the <a href="https://abot-ai.com/terms/#software" target="_blank" rel="noopener noreferrer">Software Terms</a> and <a href="https://abot-ai.com/privacy/#software" target="_blank" rel="noopener noreferrer">Software Privacy Policy</a>.</span></label>
  </div><div class="mac-permission-footer"><span>Collection starts only through Spark controls.</span>
    <div><button type="button" data-collection-consent-cancel>Cancel</button>
      <button type="button" class="mac-permission-continue" data-collection-consent-continue disabled>Continue</button></div>
  </div>`;
  (documentRoot.body ?? container).append(dialog);
  const checkbox = dialog.querySelector("[data-collection-consent-acknowledged]");
  const proceed = dialog.querySelector("[data-collection-consent-continue]");
  let pending;
  let returnFocus;

  function finish(approved) {
    if (!pending) return;
    const resolve = pending;
    pending = undefined;
    dialog.close();
    if (returnFocus?.isConnected && !returnFocus.closest("[hidden]")) returnFocus.focus();
    resolve(approved);
  }
  checkbox.addEventListener("change", () => { proceed.disabled = !checkbox.checked; });
  proceed.addEventListener("click", () => {
    if (!checkbox.checked || proceed.disabled) return;
    finish(true);
  });
  for (const button of dialog.querySelectorAll("[data-collection-consent-cancel]"))
    button.addEventListener("click", () => finish(false));
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish(false); });
  dialog.addEventListener("close", () => finish(false));
  return {
    confirm() {
      if (pending) return Promise.resolve(false);
      checkbox.checked = false;
      proceed.disabled = true;
      returnFocus = documentRoot.activeElement;
      return new Promise((resolve) => {
        pending = resolve;
        dialog.showModal();
        dialog.querySelector("h2").focus();
      });
    },
    cancel() { finish(false); },
  };
}
