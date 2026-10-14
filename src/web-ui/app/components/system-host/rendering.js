import { escapeHtml } from "../../lib/text-format.js";
import { renderWindowsStoreSetup, windowsStorePanelIsAvailable } from "./windows-store-setup.js";
import { renderConnectionCard, renderComputerMetadata } from "./connection-card.js";
import { shouldRenderNativeWindowsAccess, renderNativeWindowsAccess } from "./native-windows-access.js";
import { macPermissionSummary, renderMacPermissionPreparation } from "./macos-permission-rendering.js";
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
function hasDirectAccess(snapshot) {
  return ["native", "wsl_interop"].includes(snapshot?.readiness?.route);
}
export function connectionStatus(snapshot, statusUnavailable, busy) {
  if (statusUnavailable) return "Status unavailable";
  if (busy || !snapshot) return "Checking";
  if (hostSetupIsReady(snapshot)) return snapshot.identity?.os === "macos" ? "Connected" : "Ready";
  if (pairedCompanionIsOffline(snapshot)) return "Paired · offline";
  if (hostCompanionUpdateRequired(snapshot)) return "Update needed";
  if (snapshot.connected) return "Computer access unavailable";
  if (snapshot?.readiness?.directAccessReady) return "Direct access available";
  return "Not connected";
}
function hostAccessIsAvailable(snapshot, supported, statusUnavailable, busy) {
  if (!supported || statusUnavailable || busy) return false;
  return hostSetupIsReady(snapshot);
}
function readyDescription(snapshot) {
  if (hasDirectAccess(snapshot))
    return "Direct commands are available. No extra installation is needed for direct commands.";
  return "You can use computer tools from your ABot chat. Permissions and Spark collection are managed separately.";
}
export function connectionTitle({ snapshot, supported, statusUnavailable, busy }) {
  if (!supported) return "Computer connection unavailable";
  if (statusUnavailable) return "Check your computer connection";
  if (busy || !snapshot) return "Checking this computer…";
  if (hostSetupIsReady(snapshot)) return hasDirectAccess(snapshot) ? "Direct computer access is ready" : "Your computer is ready";
  if (pairedCompanionIsOffline(snapshot)) return "Your computer is offline";
  if (hostCompanionUpdateRequired(snapshot)) return "Update your computer connection";
  if (snapshot.connected) return "Check your computer connection";
  const platforms = snapshot.readiness?.platforms || [];
  if (platforms.length === 1 && platforms[0] === "macos") return "Connect your Mac";
  if (platforms.length === 1 && platforms[0] === "linux") return "Connect your Linux computer";
  return "Connect your computer";
}
export function connectionDescription({ snapshot, supported, statusUnavailable, busy }) {
  if (!supported) return "Computer access setup requires the local Runtime backend.";
  if (statusUnavailable) return "The current connection status could not be checked. Refresh to try again.";
  if (busy || !snapshot) return "Waiting for the current connection status…";
  if (hostSetupIsReady(snapshot)) return readyDescription(snapshot);
  if (pairedCompanionIsOffline(snapshot)) return "Reconnect Companion on this computer. Your saved connection is still available.";
  if (hostCompanionUpdateRequired(snapshot)) return "Update Companion, then return here to check the connection.";
  return "Connect this computer to use its apps and desktop tools from ABot.";
}
function renderSetupActions(snapshot, disabled) {
  if (hostSetupIsReady(snapshot)) return "";
  const platforms = snapshot?.readiness?.platforms || [];
  const setupLabels = { linux: "Set up Linux access" };
  const updateLabels = { linux: "Update Linux connection" };
  const labels = hostCompanionUpdateRequired(snapshot) ? updateLabels : setupLabels;
  return renderMacSetupAction(snapshot, disabled) + platforms
    .filter((platform) => Object.hasOwn(labels, platform))
    .map((platform) => `<button type="button" class="system-host-card-primary" data-system-host-install="${platform}" ${disabled ? "disabled" : ""}>${labels[platform]}</button>`).join("");
}
function hasDownloadablePlatform(snapshot) {
  if (hostSetupIsReady(snapshot)) return false;
  return snapshot?.readiness?.platforms?.includes("linux") === true;
}
function setupDownloadHasExpired(downloaded) {
  if (!downloaded?.expiresAt) return false;
  return Date.parse(downloaded.expiresAt) <= Date.now();
}
function shouldShowSetupReadinessNote(snapshot) {
  if (hostSetupIsReady(snapshot)) return false;
  const platforms = snapshot?.readiness?.platforms || [];
  if (platforms.length === 1 && platforms[0] === "windows") return false;
  return Boolean(snapshot?.readiness?.message);
}
function renderSetupDownload(downloaded) {
  if (!downloaded) return "";
  const expired = setupDownloadHasExpired(downloaded);
  return `<div class="system-host-download"><p><strong>Downloaded:</strong> ${escapeHtml(downloaded.filename)}</p><p>${expired ? "Setup download expired. Download setup again." : "Open this file to continue. A download alone does not mean access is ready."}</p>${downloaded.expiresAt && !expired ? `<p class="system-host-note">Open before ${escapeHtml(new Date(downloaded.expiresAt).toLocaleTimeString())}.</p>` : ""}</div>`;
}
function renderOtherPlatformSetup({ snapshot, busy, manualMac, downloaded }) {
  const actions = renderSetupActions(snapshot, busy);
  const download = renderSetupDownload(downloaded);
  const instructions = renderMacConnectionInstructions(manualMac);
  if (!actions && !download && !instructions) return "";
  return `<div class="system-host-card-other">${renderMacSetupNotice(snapshot)}${instructions}${download}${hasDownloadablePlatform(snapshot) ? "<p>Download setup for the computer hosting ABot, then open the downloaded file. Follow any permission prompts shown by your operating system.</p>" : ""}${actions ? `<div class="system-host-actions">${actions}</div>` : ""}</div>`;
}
function connectedCardHidesPermissions(input) {
  if (!input.snapshot?.connected || !canRenderCompactConnection(input)) return false;
  if (input.managementOpen || input.macPermissionError || input.nativeMacPermissionError) return false;
  return true;
}
function renderPermissionDetails(input) {
  if (!input.supported || connectedCardHidesPermissions(input)) return "";
  const content = renderMacPermissionPreparation(input);
  if (!content || !input.compact) return content;
  const summary = macPermissionSummary(input.snapshot, input.macPermissions, input.nativeMacPermissions);
  const open = input.managementOpen || input.macPermissionError || input.nativeMacPermissionError;
  return `<details class="system-host-permission-details" data-system-host-management ${open ? "open" : ""}>
    <summary>Mac permissions<span class="system-host-summary-permissions">${escapeHtml(summary)}</span></summary>
    ${content}
  </details>`;
}
function canRenderCompactConnection(input) {
  if (!input.compact) return false;
  if (!hostAccessIsAvailable(input.snapshot, input.supported, input.statusUnavailable, input.busy)) return false;
  if (input.error || input.message) return false;
  if (input.downloaded || input.manualMac) return false;
  return true;
}
export function renderSystemHostConnection(input) {
  if (shouldRenderNativeWindowsAccess(input))
    return renderNativeWindowsAccess(input);
  if (input.supported && windowsStorePanelIsAvailable(input.snapshot)) {
    return renderWindowsStoreSetup({
      snapshot: input.snapshot, invitation: input.windowsStoreInvitation,
      attempt: input.windowsStoreAttempt, disabled: input.busy,
      statusUnavailable: input.statusUnavailable, error: input.error, message: input.message,
      compact: input.compact,
      otherSetup: renderOtherPlatformSetup(input),
    });
  }
  const ready = hostAccessIsAvailable(input.snapshot, input.supported, input.statusUnavailable, input.busy);
  const compact = canRenderCompactConnection(input);
  const permissions = renderPermissionDetails(input);
  const metadata = renderComputerMetadata(input.snapshot, input.busy || !input.supported);
  const snapshot = input.snapshot;
  const setup = input.supported ? renderSetupActions(snapshot, input.busy) : "";
  const refresh = '<button type="button" class="system-host-card-secondary" data-system-host-refresh' +
    (input.busy || !input.supported ? " disabled" : "") + '>Refresh status</button>';
  return renderConnectionCard({
    title: connectionTitle(input), status: input.supported ? connectionStatus(snapshot, input.statusUnavailable, input.busy) : "Unavailable",
    ready, compact, disabled: input.busy, metadata,
    description: connectionDescription(input),
    actions: setup + refresh,
    error: input.error, message: input.message,
    details: compact ? permissions : `
      ${input.supported ? renderMacSetupNotice(snapshot) + renderMacConnectionInstructions(input.manualMac) : ""}
      ${shouldShowSetupReadinessNote(snapshot) ? `<p class="system-host-note">${escapeHtml(snapshot.readiness.message)}</p>` : ""}
      ${hasDownloadablePlatform(snapshot) && input.supported ? "<p class=\"system-host-note\">Download setup for the computer hosting ABot, then open the downloaded file. It checks prerequisites and connects automatically. Follow any permission prompts shown by your operating system.</p>" : ""}
      ${renderSetupDownload(input.downloaded)}
      ${permissions}
    `,
  });
}
