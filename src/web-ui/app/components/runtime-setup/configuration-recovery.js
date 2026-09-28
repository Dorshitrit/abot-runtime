import { escapeHtml } from "../../lib/text-format.js";

export function requiresConfigurationRecovery(availability) {
  return availability?.recovery === "configuration";
}

export function preserveConfigurationRecovery(current, incoming) {
  if (!requiresConfigurationRecovery(current)) return incoming;
  const transient =
    incoming.status === "checking" || incoming.status === "error";
  if (!transient) return incoming;
  return { ...incoming, recovery: "configuration" };
}

export function renderConfigurationRecovery(availability) {
  const checking = availability.status === "checking";
  return `<section class="runtime-setup-panel" aria-labelledby="runtimeSetupRecoveryTitle">
    <header class="runtime-setup-heading"><h3 id="runtimeSetupRecoveryTitle" tabindex="-1" data-runtime-setup-title>Review your existing configuration</h3>
    <p>Your model profiles are saved, but need attention before ABot can start.</p></header>
    <div class="runtime-setup-content"><p role="status">${escapeHtml(availability.message || "Open Models to repair the existing model and provider settings.")}</p>
    <p>Open Models to review your model profiles and provider connections. Your existing settings will be preserved.</p></div>
    <footer class="runtime-setup-footer"><button type="button" class="runtime-setup-secondary" data-runtime-setup-action="check" ${checking ? "disabled" : ""}>${checking ? "Checking…" : "Check again"}</button>
    <button type="button" class="runtime-setup-action" data-runtime-setup-action="configuration" ${checking ? "disabled" : ""}>Open Models</button></footer>
  </section>`;
}
