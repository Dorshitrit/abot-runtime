import { escapeHtml } from "../../lib/text-format.js";
import { canCheckMacPermissions, canCheckNativePermissions, permissionsMatchConnection, permissionsMatchNativeOwner } from "./macos-permission-scopes.js";

function hasNativePermissionSurface(snapshot) {
  if (snapshot?.identity?.os === "macos") return true;
  if (!snapshot?.nativePermissions) return false;
  return snapshot.nativePermissions.reason !== "native_macos_unavailable";
}
function permissionSummary(receipt) {
  if (!receipt) return "not checked";
  if (receipt.permissions.screenRecording !== "granted") return "action needed";
  if (receipt.permissions.accessibility !== "granted") return "action needed";
  return "granted";
}
export function macPermissionSummary(snapshot, receipt, nativeReceipt) {
  const parts = [];
  if (hasNativePermissionSurface(snapshot)) {
    const native = snapshot.nativePermissions;
    const current = permissionsMatchNativeOwner(nativeReceipt, snapshot, native?.environmentId) ? nativeReceipt : null;
    parts.push(`SYSTEM · ${native?.available ? permissionSummary(current) : "unavailable"}`);
  }
  if (snapshot?.identity?.os === "macos" && snapshot.connected) {
    const current = permissionsMatchConnection(receipt, snapshot) ? receipt : null;
    parts.push(`Companion · ${canCheckMacPermissions(snapshot) ? permissionSummary(current) : "update needed"}`);
  }
  return parts.join(" · ");
}
function permissionStatusLabel(status) {
  if (status === "granted") return "Granted";
  if (status === "required") return "Required";
  return "Not checked";
}
function permissionRow(label, permission, status, selector, disabled) {
  return `<div class="system-host-permission-row"><strong>${label}</strong>
    <span class="system-host-permission-state" data-granted="${status === "granted"}">${permissionStatusLabel(status)}</span>
    ${status === "required" ? `<button type="button" data-${selector}-permission-request="${permission}" ${disabled ? "disabled" : ""}>Allow ${label}</button>` : ""}</div>`;
}
function renderPermissionRoute({ title, description, selector, available, receipt, identity, permissionHelp, error, disabled }) {
  return `<section class="system-host-permission-route" data-permission-route="${selector}">
    <div class="system-host-permission-heading"><h4>${title}</h4>
      ${available ? `<button type="button" data-${selector}-permissions-check ${disabled ? "disabled" : ""}>${receipt ? "Check again" : "Check permissions"}</button>` : ""}</div>
    <p class="system-host-note">${escapeHtml(description)}</p>
    ${available ? permissionRow("Screen Recording", "screen_recording", receipt?.permissions.screenRecording, selector, disabled) + permissionRow("Accessibility", "accessibility", receipt?.permissions.accessibility, selector, disabled) : ""}
    ${identity ? `<p class="system-host-note">${identity}</p>` : ""}
    ${receipt ? `<code class="system-host-permission-path" dir="ltr">${escapeHtml(receipt.executablePath)}</code><p class="system-host-note">${permissionHelp} After changing access, choose Check again.${receipt.restartMayBeRequired ? " macOS may require a restart before the new access takes effect; finish setup before starting a conversation." : ""}</p>` : ""}
    ${error ? `<p role="alert" class="error-text">${escapeHtml(error)}</p>` : ""}
  </section>`;
}
function nativeUnavailableDescription(native) {
  if (!native) return "Update ABot to check the native SYSTEM route. Companion approval does not confirm SYSTEM access.";
  if (native.reason === "native_macos_unavailable") return "The selected Runtime is not running natively on macOS. Companion permissions do not grant SYSTEM access on another computer.";
  if (native.reason === "local_browser_required") return "Open ABot’s local Web UI on the Mac running the Runtime to prepare SYSTEM permissions.";
  if (native.reason === "runtime_not_started") return "Start the selected Runtime, then refresh Computer access to prepare SYSTEM permissions.";
  return "The selected Runtime cannot report its permission identity. Update or reconnect it, then refresh Computer access.";
}
export function renderMacPermissionPreparation({ snapshot, macPermissions, macPermissionError, nativeMacPermissions, nativeMacPermissionError, busy, statusUnavailable }) {
  const showNative = hasNativePermissionSurface(snapshot);
  const showCompanion = snapshot?.identity?.os === "macos" && snapshot.paired;
  if (!showNative && !showCompanion) return "";
  const native = snapshot.nativePermissions;
  const nativeAvailable = canCheckNativePermissions(snapshot, native?.environmentId);
  const nativeReceipt = permissionsMatchNativeOwner(nativeMacPermissions, snapshot, native?.environmentId) ? nativeMacPermissions : null;
  const companionAvailable = canCheckMacPermissions(snapshot);
  const companionReceipt = permissionsMatchConnection(macPermissions, snapshot) ? macPermissions : null;
  const disabled = busy || statusUnavailable;
  return `<section class="system-host-permissions" data-system-host-mac-permissions aria-label="macOS permission preparation">
    <h3>Prepare Mac permissions before a conversation</h3>
    <p class="system-host-note">SYSTEM and the companion can run under different apps or on different computers. Check each route you use. Checks do not capture content or start Spark; Allow buttons explicitly request access.</p>
    ${showNative ? renderPermissionRoute({
      title: "SYSTEM · ABot Runtime", selector: "native-mac", available: nativeAvailable, receipt: nativeReceipt,
      description: nativeAvailable ? "Direct SYSTEM commands use the selected Runtime’s permissions. Allow Terminal or the application shown by macOS. If asked to reopen it, do so before starting a conversation, then check again." : nativeUnavailableDescription(native),
      identity: nativeAvailable ? `Runtime computer: <strong>${escapeHtml(native.computerName)}</strong> · Environment: <strong>${escapeHtml(native.environmentId)}</strong>` : "",
      permissionHelp: "This path identifies the Runtime process; macOS may assign its permissions to Terminal or the application that started it.",
      error: nativeMacPermissionError, disabled,
    }) : ""}
    ${showCompanion ? renderPermissionRoute({
      title: "Computer tools · ABot companion", selector: "mac", available: companionAvailable, receipt: companionReceipt,
      description: companionAvailable ? "Screen capture and computer control through the connected companion. Spark collection is controlled separately." : "Connect or update the Mac companion to check its permissions here.",
      identity: `Companion computer: <strong>${escapeHtml(snapshot.identity.name || "Connected Mac")}</strong>`,
      permissionHelp: "macOS may label the companion “node”. Match this exact path in System Settings → Privacy &amp; Security.",
      error: macPermissionError, disabled,
    }) : ""}
    <p class="system-host-note">These checks cover Screen Recording and Accessibility. Access to protected folders and automation of individual apps can require additional approval.</p>
  </section>`;
}
