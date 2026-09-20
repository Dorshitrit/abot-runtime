import { escapeHtml } from "../../lib/text-format.js";

export function hostSetupIsReady(snapshot) {
  if (snapshot?.readiness) return snapshot.readiness.ready === true;
  return snapshot?.connected === true;
}
function connectionStatus(snapshot, statusUnavailable, busy) {
  if (statusUnavailable) return "Status unavailable";
  if (busy || !snapshot) return "Checking this computer…";
  if (hostSetupIsReady(snapshot)) return "Ready";
  if (snapshot.paired) return "Paired · offline";
  return "Setup needed";
}
function readyDescription(snapshot) {
  if (snapshot?.readiness?.route === "native")
    return "ABot can already use this computer. No extra installation is needed.";
  if (snapshot?.readiness?.route === "wsl_interop")
    return "Windows access through WSL is ready. No extra installation is needed.";
  return "Your computer is connected and ready.";
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
  const labels = {
    windows: "Set up Windows access",
    macos: "Set up Mac access",
  };
  return platforms
    .filter((platform) => Object.hasOwn(labels, platform))
    .map(
      (platform) =>
        `<button type="button" data-system-host-install="${platform}" ${disabled ? "disabled" : ""}>${labels[platform]}</button>`,
    )
    .join("");
}
function hasInstallablePlatform(snapshot) {
  if (hostSetupIsReady(snapshot)) return false;
  return (
    snapshot?.readiness?.platforms?.some((platform) =>
      ["windows", "macos"].includes(platform),
    ) === true
  );
}
function setupDownloadHasExpired(downloaded) {
  if (!downloaded?.expiresAt) return false;
  return Date.parse(downloaded.expiresAt) <= Date.now();
}
export function renderSystemHostConnection({
  snapshot,
  supported,
  busy,
  error,
  message,
  statusUnavailable,
  downloaded,
}) {
  const ready = hostSetupIsReady(snapshot);
  const restart = snapshot?.readiness?.restartRequired === true;
  return `<section class="system-host-panel" aria-label="Connected computer" aria-busy="${busy ? "true" : "false"}">
    <div class="system-host-heading"><div><h2>Computer access</h2><p>Use applications and system commands on your computer.</p></div><button type="button" data-system-host-refresh ${busy || !supported ? "disabled" : ""}>Refresh status</button></div>
    <p class="system-host-note">Shared by all environments in this ABot installation. Your selected tools and ASK, Full or Full+ mode still apply.</p>
    <p class="system-host-status" role="status">${supported ? connectionStatus(snapshot, statusUnavailable, busy) : "Computer access setup requires the local Runtime backend."}</p>
    ${ready && !statusUnavailable && !busy ? `<p>${readyDescription(snapshot)}</p>` : ""}
    ${renderIdentity(snapshot)}
    ${!ready && snapshot?.readiness?.message ? `<p class="system-host-note">${escapeHtml(snapshot.readiness.message)}</p>` : ""}
    ${hasInstallablePlatform(snapshot) && supported ? "<p>Download setup for the computer hosting ABot, then open the downloaded file. It installs what is needed and connects automatically. Follow any permission prompts shown by your operating system.</p>" : ""}
    ${restart ? '<p class="system-host-restart" role="note">Opening the setup file enables Windows access and automatically restarts the selected WSL distribution. This interrupts its services and conversations. Finish active work before opening the setup file.</p>' : ""}
    ${downloaded ? `<div class="system-host-download"><p><strong>Downloaded:</strong> ${escapeHtml(downloaded.filename)}</p><p>${setupDownloadHasExpired(downloaded) ? "Setup download expired. Download setup again." : "Open this file to continue. A download alone does not mean access is ready."}</p>${downloaded.expiresAt && !setupDownloadHasExpired(downloaded) ? `<p class="system-host-note">Open before ${escapeHtml(new Date(downloaded.expiresAt).toLocaleTimeString())}.</p>` : ""}</div>` : ""}
    <div class="${error ? "error-text" : "system-host-note"}" role="${error ? "alert" : "status"}" aria-live="polite">${escapeHtml(error || message || "")}</div>
    <div class="system-host-actions">${supported ? renderSetupActions(snapshot, busy) : ""}${snapshot?.paired ? `<button type="button" data-system-host-revoke ${busy ? "disabled" : ""}>Disconnect computer</button>` : ""}</div>
  </section>`;
}
