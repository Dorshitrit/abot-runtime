import { escapeHtml } from "../../lib/text-format.js";
import { renderMacPermissionGuide } from "./macos-permissions.js";
import {
  renderMacSetupAction,
  renderMacSetupNotice,
  renderMacConnectionInstructions,
} from "./macos-setup.js";

export function hostSetupIsReady(snapshot) {
  if (snapshot?.readiness) return snapshot.readiness.ready === true;
  return snapshot?.connected === true;
}
function hostCompanionUpdateRequired(snapshot) {
  return snapshot?.readiness?.companionUpdateRequired === true;
}
function pairedCompanionIsOffline(snapshot) {
  if (!snapshot?.paired) return false;
  return snapshot.connected === false;
}
function connectionStatus(snapshot, statusUnavailable, busy) {
  if (statusUnavailable) return "Status unavailable";
  if (busy || !snapshot) return "Checking this computer…";
  if (hostSetupIsReady(snapshot)) return "Ready";
  if (pairedCompanionIsOffline(snapshot)) return "Paired · offline";
  if (hostCompanionUpdateRequired(snapshot)) return "Update needed";
  if (snapshot.connected) return "Computer access unavailable";
  if (snapshot?.readiness?.directAccessReady) return "Direct access available";
  return "Setup needed";
}
function hostAccessIsAvailable(snapshot, supported, statusUnavailable, busy) {
  if (!supported || statusUnavailable || busy) return false;
  return hostSetupIsReady(snapshot);
}
function readyDescription(snapshot) {
  if (["native", "wsl_interop"].includes(snapshot?.readiness?.route))
    return "Direct commands are available. No extra installation is needed for direct commands.";
  return "Your computer is connected for system tools and ABot Spark. Background collection starts only when you enable it.";
}
function renderIdentity(snapshot) {
  const identity = snapshot?.identity || {};
  const fields = [
    ["Computer", identity.name],
    ["Operating system", identity.os],
    ["User", identity.user],
    ["Computer ID", snapshot?.hostId],
  ];
  return `<dl class="system-host-identity">${fields
    .filter(([, value]) => typeof value === "string" && value.length > 0)
    .map(
      ([label, value]) =>
        `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`,
    )
    .join("")}</dl>`;
}
function renderSetupActions(snapshot, disabled) {
  if (hostSetupIsReady(snapshot)) return "";
  const platforms = snapshot?.readiness?.platforms || [];
  const setupLabels = {
    windows: "Set up Windows access",
    linux: "Set up Linux access",
  };
  const updateLabels = {
    windows: "Update Windows connection",
    linux: "Update Linux connection",
  };
  const labels = hostCompanionUpdateRequired(snapshot)
    ? updateLabels
    : setupLabels;
  return (
    renderMacSetupAction(snapshot, disabled) +
    platforms
      .filter((platform) => Object.hasOwn(labels, platform))
      .map(
        (platform) =>
          `<button type="button" data-system-host-install="${platform}" ${disabled ? "disabled" : ""}>${labels[platform]}</button>`,
      )
      .join("")
  );
}
function hasInstallablePlatform(snapshot) {
  if (hostSetupIsReady(snapshot)) return false;
  return (
    snapshot?.readiness?.platforms?.some((platform) =>
      ["windows", "linux"].includes(platform),
    ) === true
  );
}
function setupDownloadHasExpired(downloaded) {
  if (!downloaded?.expiresAt) return false;
  return Date.parse(downloaded.expiresAt) <= Date.now();
}
export function renderSystemHostConnection(input) {
  const content = renderConnectionDetails(input);
  if (!input.compact) return content;
  const { snapshot, supported, statusUnavailable, busy, managementOpen } = input;
  const available = hostAccessIsAvailable(snapshot, supported, statusUnavailable, busy);
  const status = supported ? connectionStatus(snapshot, statusUnavailable, busy) : "Unavailable";
  return `<details class="system-host-compact" data-system-host-management ${managementOpen ? "open" : ""}>
    <summary class="system-host-summary">
      <span class="system-host-summary-title">Computer access</span>
      <span class="system-host-status" role="status" data-tone="${available ? "ready" : "unavailable"}"><span class="system-host-status-dot" aria-hidden="true"></span>${escapeHtml(status)}</span>
      <span class="system-host-summary-name">${escapeHtml(snapshot?.identity?.name || "")}</span>
      <span class="system-host-summary-action" aria-hidden="true"><span>⌄</span></span>
    </summary>
    <div class="system-host-management-body">${content}</div>
  </details>`;
}

function renderConnectionDetails({
  snapshot,
  supported,
  busy,
  error,
  message,
  statusUnavailable,
  downloaded,
  manualMac,
}) {
  const ready = hostSetupIsReady(snapshot);
  const available = hostAccessIsAvailable(
    snapshot,
    supported,
    statusUnavailable,
    busy,
  );
  const restart = snapshot?.readiness?.restartRequired === true;
  return `<section class="system-host-panel" aria-label="Connected computer" aria-busy="${busy ? "true" : "false"}">
    <div class="system-host-heading"><div><h2>Computer access</h2><p>One connection for computer tools and ABot Spark.</p></div><button type="button" data-system-host-refresh ${busy || !supported ? "disabled" : ""}>Refresh status</button></div>
    <p class="system-host-note">Shared by all environments and compatible plugins in this ABot installation. Tool approvals and ABot Spark collection are controlled separately.</p>
    <p class="system-host-status" role="status" data-tone="${available ? "ready" : "unavailable"}"><span class="system-host-status-dot" aria-hidden="true"></span><span>${supported ? connectionStatus(snapshot, statusUnavailable, busy) : "Computer access setup requires the local Runtime backend."}</span></p>
    ${ready && !statusUnavailable && !busy ? `<p>${readyDescription(snapshot)}</p>` : ""}
    ${renderIdentity(snapshot)}
    ${supported ? renderMacPermissionGuide(snapshot) : ""}
    ${supported ? renderMacSetupNotice(snapshot) : ""}
    ${supported ? renderMacConnectionInstructions(manualMac) : ""}
    ${!ready && snapshot?.readiness?.message ? `<p class="system-host-note">${escapeHtml(snapshot.readiness.message)}</p>` : ""}
    ${hasInstallablePlatform(snapshot) && supported ? "<p>Download setup for the computer hosting ABot, then open the downloaded file. It checks prerequisites and connects automatically. Follow any permission prompts shown by your operating system.</p>" : ""}
    ${restart ? '<p class="system-host-restart" role="note">Opening the setup file enables Windows access and automatically restarts the selected WSL distribution. This interrupts its services and conversations. Finish active work before opening the setup file.</p>' : ""}
    ${downloaded ? `<div class="system-host-download"><p><strong>Downloaded:</strong> ${escapeHtml(downloaded.filename)}</p><p>${setupDownloadHasExpired(downloaded) ? "Setup download expired. Download setup again." : "Open this file to continue. A download alone does not mean access is ready."}</p>${downloaded.expiresAt && !setupDownloadHasExpired(downloaded) ? `<p class="system-host-note">Open before ${escapeHtml(new Date(downloaded.expiresAt).toLocaleTimeString())}.</p>` : ""}</div>` : ""}
    <div class="${error ? "error-text" : "system-host-note"}" role="${error ? "alert" : "status"}" aria-live="polite">${escapeHtml(error || message || "")}</div>
    ${snapshot?.paired ? '<p class="system-host-note">Unpairing disconnects this companion. To reconnect, run Computer access setup again. Saved insights are kept.</p>' : ""}
    <div class="system-host-actions">${supported ? renderSetupActions(snapshot, busy) : ""}${snapshot?.paired ? `<button type="button" data-system-host-revoke ${busy ? "disabled" : ""}>Unpair computer</button>` : ""}</div>
  </section>`;
}
