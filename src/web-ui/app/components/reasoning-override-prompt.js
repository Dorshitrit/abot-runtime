import { escapeHtml } from "../lib/text-format.js";
import { enableModelReasoning } from "../services/reasoning-override.js";

/** A non-modal prompt anchored in the existing composer mode menu. */
export function createReasoningOverridePrompt({ root, client, getEnvironmentId, getProfile, refreshModels, render }) {
  let context = "";
  let revision = 0;
  let busy = false;
  let saved = false;
  let message = "";
  let failed = false;
  let wasOpen = false;
  const currentContext = () => JSON.stringify([getEnvironmentId(), getProfile()?.id]);
  const ownsReasoningPrompt = (captured) => revision === captured.revision && context === captured.key && currentContext() === captured.key;

  function reset() {
    revision += 1;
    context = ""; busy = false; saved = false; message = ""; failed = false; wasOpen = false;
  }

  async function enable(applyNow) {
    if (busy || !getProfile()) return;
    const captured = { key: currentContext(), revision };
    const environmentId = getEnvironmentId();
    const profileId = getProfile().id;
    busy = true; failed = false; message = "Saving…"; render();
    try {
      await enableModelReasoning(client, profileId, environmentId);
      if (!ownsReasoningPrompt(captured)) return;
      saved = true;
      message = "Saved. Reasoning controls will be available after Runtime restarts.";
      if (!applyNow) return;
      message = "Applying saved configuration…"; render();
      const result = await client.applyRuntimeConfiguration(environmentId);
      if (!ownsReasoningPrompt(captured)) return;
      if (result?.activation?.status !== "ready") {
        message = result?.activation?.message || "Saved. Apply again when Runtime is idle, or restart it later.";
        return;
      }
      const refreshed = await refreshModels();
      if (!ownsReasoningPrompt(captured)) return;
      if (!refreshed) throw new Error("Configuration applied. Reload to refresh the model's reasoning controls.");
      message = "Configuration applied. Reload if this model still uses provider defaults.";
    } catch (error) {
      if (!ownsReasoningPrompt(captured)) return;
      failed = true;
      message = `${saved ? "Saved; not confirmed active. " : ""}${error.message || String(error)}`;
    } finally {
      if (ownsReasoningPrompt(captured)) { busy = false; render(); }
    }
  }

  function renderPrompt(open) {
    const next = currentContext();
    if (context !== next) { reset(); context = next; }
    const restoreFocus = Boolean(root.contains?.(root.ownerDocument?.activeElement));
    const focusOnOpen = open && !wasOpen;
    wasOpen = open;
    if (!open) { root.innerHTML = ""; return; }
    const profile = getProfile();
    const canSave = Boolean(profile) && typeof client.loadConfigDashboard === "function" && typeof client.saveConfigFile === "function";
    root.innerHTML = `<section class="reasoning-override-prompt">
      <strong>Enable reasoning controls?</strong>
      <p><span>${escapeHtml(profile?.label || profile?.id || "This model")}</span> currently uses the provider’s default. Enable this only if the model supports reasoning controls.</p>
      <div class="reasoning-override-actions">
        <button type="button" data-reasoning-enable="now"${busy || !canSave || typeof client.applyRuntimeConfiguration !== "function" ? " disabled" : ""}>${saved ? "Apply now" : "Enable and apply now"}</button>
        <button type="button" data-reasoning-enable="later"${busy || saved || !canSave ? " disabled" : ""}>Enable on next start</button>
      </div>
      <small>Apply now restarts idle Runtime environments with all saved settings. Active work will not be interrupted.</small>
      <p class="reasoning-override-status${failed ? " error-text" : ""}" role="status" aria-live="polite"${message ? "" : " hidden"}>${escapeHtml(message)}</p>
    </section>`;
    for (const button of root.querySelectorAll("[data-reasoning-enable]")) {
      button.addEventListener("click", () => void enable(button.dataset.reasoningEnable === "now"));
    }
    if (focusOnOpen || restoreFocus) {
      const target = root.querySelector?.("button:not(:disabled)");
      root.tabIndex = -1;
      (target || root).focus();
    }
  }
  return { render: renderPrompt, reset };
}
