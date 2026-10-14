import { escapeHtml } from "../../lib/text-format.js";
import { renderConnectionCard, renderComputerMetadata } from "./connection-card.js";

const companionStoreUrl = "https://apps.microsoft.com/detail/9PK2FDQQLQS9";

export function windowsStoreSetupIsAvailable(snapshot) {
  const readiness = snapshot?.readiness;
  if (readiness?.ready === true) return false;
  if (!readiness?.platforms?.includes("windows")) return false;
  if (readiness.restartRequired === true) return false;
  return ["setup_required", "companion"].includes(readiness.route);
}

export function windowsStorePanelIsAvailable(snapshot) {
  if (windowsStoreSetupIsAvailable(snapshot)) return true;
  if (snapshot?.readiness?.restartRequired === true) return false;
  if (snapshot?.readiness?.route !== "companion") return false;
  if (snapshot.readiness.ready !== true) return false;
  return snapshot.identity?.os === "windows";
}

function windowsCompanionCanReconnect(snapshot) {
  if (!windowsStoreSetupIsAvailable(snapshot)) return false;
  if (snapshot?.paired !== true) return false;
  return snapshot.connected === false;
}

function hasConfirmedUnpairedConnection(snapshot) {
  if (snapshot?.ok === false) return false;
  if (snapshot?.paired !== false) return false;
  return snapshot.connected === false;
}

function storeInvitationIsCurrent(invitation) {
  if (!invitation) return false;
  return Date.parse(invitation.expiresAt) > Date.now();
}

function storeRepairConfirmationIsCurrent(snapshot, attempt) {
  if (!windowsCompanionCanReconnect(snapshot)) return false;
  return attempt?.phase === "confirm-repair";
}

export function storeConnectionStage(snapshot, invitation, attempt) {
  if (snapshot?.readiness?.ready === true) return "ready";
  if (attempt?.phase === "repairing") return "repairing";
  if (storeRepairConfirmationIsCurrent(snapshot, attempt)) return "confirm-repair";
  if (windowsCompanionCanReconnect(snapshot)) return "reconnect";
  if (attempt?.expiresAt && Date.parse(attempt.expiresAt) <= Date.now()) return "expired";
  if (attempt?.phase === "preparing") return "preparing";
  if (attempt?.phase === "waiting") return "waiting";
  if (storeInvitationIsCurrent(invitation)) return "open";
  if (attempt?.phase === "expired") return "expired";
  return "start";
}

function connectionButton(label, disabled, secondary = false) {
  return `<button type="button" class="system-host-card-${secondary ? "secondary" : "primary"}" data-system-host-store-connect ${disabled ? "disabled" : ""}>${label}</button>`;
}

function companionLaunchLink(invitation, secondary = false) {
  return `<a class="system-host-card-${secondary ? "secondary" : "primary"}" href="${escapeHtml(invitation.launchUrl)}" data-system-host-store-launch rel="noreferrer">${secondary ? "Open Companion again" : "Open Companion"}</a>`;
}

function connectionStageContent(stage, snapshot, invitation, disabled) {
  if (stage === "ready") return {
    status: "Connected", step: "Your computer is ready", copy: "You can use computer tools from your ABot chat.",
  };
  if (stage === "reconnect") return {
    status: "Offline", step: "Your computer is offline", copy: `Open Companion on ${snapshot?.identity?.name || "your computer"} to reconnect.`,
    action: `<a class="system-host-card-primary" href="abot-companion://open" data-system-host-store-open-existing rel="noreferrer">Open Companion</a><button type="button" class="system-host-card-secondary" data-system-host-store-repair ${disabled ? "disabled" : ""}>Set up again</button>`,
    help: "Removed the connection in Companion? Choose Set up again.",
  };
  if (stage === "confirm-repair") return {
    status: "Confirm reset", step: "Set up this computer again?", copy: "The previous connection will be removed. You’ll approve a new connection in Companion.",
    action: `<button type="button" class="system-host-card-primary" data-system-host-store-repair-confirm ${disabled ? "disabled" : ""}>Continue</button><button type="button" class="system-host-card-secondary" data-system-host-store-repair-cancel ${disabled ? "disabled" : ""}>Cancel</button>`,
    help: "Your conversations and saved insights will be kept.",
  };
  if (stage === "repairing") return {
    status: "Preparing", step: "Setting up this computer again", copy: "Removing the previous connection before preparing your new connection…",
    action: '<button type="button" class="system-host-card-primary" disabled>Preparing connection…</button>',
  };
  if (stage === "preparing") return {
    status: "Preparing", step: "Connect your Windows computer", copy: "Preparing your connection…",
    action: connectionButton("Preparing connection…", true),
  };
  if (stage === "open") return {
    status: "Waiting for you", step: "Approve the connection in Companion", copy: "Open the app and check the ABot address. This page will confirm when your computer is connected.",
    action: companionLaunchLink(invitation),
    help: "Your browser may ask permission to open the app.",
  };
  if (stage === "waiting") return {
    status: "Waiting for approval", step: "Approve the connection in Companion", copy: "Check the ABot address and approve the connection in the app. This page will confirm when your computer is connected.",
    help: "If Companion did not open, use the option below.",
    action: storeInvitationIsCurrent(invitation)
      ? companionLaunchLink(invitation, true)
      : connectionButton("Start connection again", disabled, true),
  };
  if (stage === "expired") return {
    status: "Expired", step: "Connection link expired", copy: "Connect again to get a fresh invitation.",
    action: connectionButton("Connect again", disabled),
  };
  const update = snapshot?.readiness?.companionUpdateRequired === true;
  return {
    status: update ? "Update needed" : "Not connected",
    step: update ? "Update Companion" : "Connect your Windows computer",
    copy: update ? "Update Companion from Microsoft Store, then return here to reconnect."
      : "Companion lets ABot work with files, apps and desktop tools on this computer.",
    action: `<a class="system-host-card-primary" href="${companionStoreUrl}" target="_blank" rel="noopener noreferrer"><svg class="system-host-store-icon" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 7h16v14H4ZM8 7V5a4 4 0 0 1 8 0v2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 10h3v3H8Zm5 0h3v3h-3Zm-5 5h3v3H8Zm5 0h3v3h-3Z" fill="currentColor"/></svg><span>${update ? "Update in Microsoft Store" : "Install from Microsoft Store"}</span></a>${connectionButton(update ? "I already updated it" : "I already have it", disabled, true)}`,
    help: update ? "Your saved connection is kept during an update." : "Install once from Microsoft Store, then return here to connect.",
  };
}

export function storeConnectionDisplayContent(stage, snapshot, invitation, disabled, statusUnavailable) {
  if (statusUnavailable) return {
    status: "Status unavailable", step: "Check your computer connection",
    copy: "The current connection status could not be checked. Refresh to try again.",
  };
  if (disabled && stage === "ready") return {
    status: "Checking", step: "Checking your computer connection",
    copy: "Waiting for the current connection status…",
  };
  return connectionStageContent(stage, snapshot, invitation, disabled);
}

function shouldRenderReadyWindowsSummary(compact, ready, error, message, otherSetup) {
  if (!compact || !ready) return false;
  if (error || message || otherSetup) return false;
  return true;
}

export function renderWindowsStoreSetup({ snapshot, invitation, attempt, disabled, statusUnavailable, error, message, compact, otherSetup = "" }) {
  if (!windowsStorePanelIsAvailable(snapshot)) return "";
  const stage = storeConnectionStage(snapshot, invitation, attempt);
  const content = storeConnectionDisplayContent(stage, snapshot, invitation, disabled, statusUnavailable);
  const ready = stage === "ready" && !statusUnavailable && !disabled;
  const summary = shouldRenderReadyWindowsSummary(compact, ready, error, message, otherSetup);
  const refresh = statusUnavailable || error ? '<button type="button" class="system-host-card-secondary" data-system-host-refresh' + (disabled ? " disabled" : "") + '>Refresh status</button>' : "";
  return renderConnectionCard({
    title: content.step, status: content.status, ready, disabled,
    compact: summary,
    description: content.copy, actions: content.action, help: content.help, error, message,
    metadata: ["ready", "reconnect"].includes(stage) ? renderComputerMetadata(snapshot, disabled) : "",
    details: summary ? "" : (ready ? '<p class="system-host-card-access-note">Computer actions follow your permission settings. Spark collection is managed separately.</p>' : "") + refresh + otherSetup,
    attributes: `data-system-host-store-setup data-system-host-store-stage="${stage}"`,
  });
}

function readStoreInvitation(receipt) {
  if (!storeInvitationIsCurrent(receipt)) throw new Error("store_invitation_expired");
  const launch = new URL(receipt.launchUrl);
  if (launch.protocol !== "abot-companion:") throw new Error("store_invitation_invalid");
  if (launch.hostname !== "connect") throw new Error("store_invitation_invalid");
  if (launch.username || launch.password || launch.port || launch.hash) throw new Error("store_invitation_invalid");
  if (launch.pathname !== "" && launch.pathname !== "/") throw new Error("store_invitation_invalid");
  if (!/^[A-Za-z0-9_-]+$/.test(launch.searchParams.get("invitation") || "")) throw new Error("store_invitation_invalid");
  if (receipt.storeUrl !== companionStoreUrl) throw new Error("store_invitation_invalid");
  return { launchUrl: launch.href, expiresAt: receipt.expiresAt };
}

/** The invitation exists only on the active surface, until readiness or expiry. */
export function createWindowsStoreConnectionActions({
  state,
  requestStoreConnection,
  revokeConnection,
  receiveUnpairedConnection,
  canInstallOnPlatform,
  beginRequest,
  finishRequest,
  isCurrentResponse,
  getSurfaceRevision,
  getEnvironmentId = () => "",
  isVisible,
  notify,
  scheduleExpiration = setTimeout,
  cancelExpiration = clearTimeout,
}) {
  let expirationTimer;
  function clear({ preserveWaiting = false } = {}) {
    if (expirationTimer !== undefined) cancelExpiration(expirationTimer);
    expirationTimer = undefined;
    if (state.windowsStoreInvitation) state.message = "";
    state.windowsStoreInvitation = null;
    if (preserveWaiting && state.windowsStoreAttempt?.phase === "waiting") return;
    state.windowsStoreAttempt = null;
  }
  function canApplyStoreResponse(operation, surface, environment) {
    if (!isCurrentResponse(operation)) return false;
    if (surface !== getSurfaceRevision()) return false;
    if (environment !== getEnvironmentId()) return false;
    return isVisible();
  }
  function receiveStoreInvitation(receipt) {
    state.windowsStoreInvitation = readStoreInvitation(receipt);
    state.windowsStoreAttempt = { phase: "open", expiresAt: receipt.expiresAt };
    state.downloaded = null;
    state.manualMac = null;
    state.message = "";
    expirationTimer = scheduleExpiration(() => {
      clear();
      state.windowsStoreAttempt = { phase: "expired" };
      notify();
    }, Date.parse(receipt.expiresAt) - Date.now());
  }
  async function connectWindowsStore() {
    if (typeof requestStoreConnection !== "function") return false;
    if (!canInstallOnPlatform("windows")) return false;
    if (!windowsStoreSetupIsAvailable(state.snapshot)) return false;
    if (windowsCompanionCanReconnect(state.snapshot)) return false;
    if (storeInvitationIsCurrent(state.windowsStoreInvitation)) return false;
    clear();
    const operation = beginRequest();
    const surface = getSurfaceRevision();
    const environment = getEnvironmentId();
    state.windowsStoreAttempt = { phase: "preparing" };
    notify();
    try {
      const receipt = await requestStoreConnection();
      if (!canApplyStoreResponse(operation, surface, environment)) return false;
      receiveStoreInvitation(receipt);
      return true;
    } catch {
      if (!canApplyStoreResponse(operation, surface, environment)) return false;
      clear();
      state.actionError = "The Companion connection link could not be created. Refresh status and try again.";
      return false;
    } finally {
      finishRequest(operation);
    }
  }
  function canRepairWindowsPairing() {
    if (!canInstallOnPlatform("windows")) return false;
    return windowsCompanionCanReconnect(state.snapshot);
  }
  function beginWindowsStoreRepair() {
    if (!canRepairWindowsPairing()) return false;
    clear();
    state.windowsStoreAttempt = { phase: "confirm-repair" };
    state.actionError = "";
    notify();
    return true;
  }
  function cancelWindowsStoreRepair() {
    if (state.busy) return false;
    if (state.windowsStoreAttempt?.phase !== "confirm-repair") return false;
    clear();
    notify();
    return true;
  }
  async function confirmWindowsStoreRepair() {
    if (!canRepairWindowsPairing()) return false;
    if (state.windowsStoreAttempt?.phase !== "confirm-repair") return false;
    if (typeof revokeConnection !== "function" || typeof requestStoreConnection !== "function") return false;
    const operation = beginRequest();
    const surface = getSurfaceRevision();
    const environment = getEnvironmentId();
    state.windowsStoreAttempt = { phase: "repairing" };
    notify();
    let revoked = false;
    try {
      const snapshot = await revokeConnection();
      if (!canApplyStoreResponse(operation, surface, environment)) return false;
      if (!hasConfirmedUnpairedConnection(snapshot)) throw new Error("unpair_not_confirmed");
      receiveUnpairedConnection(snapshot);
      revoked = true;
      if (!windowsStoreSetupIsAvailable(snapshot)) throw new Error("store_setup_unavailable");
      state.windowsStoreAttempt = { phase: "preparing" };
      state.message = "";
      notify();
      const receipt = await requestStoreConnection();
      if (!canApplyStoreResponse(operation, surface, environment)) return false;
      receiveStoreInvitation(receipt);
      return true;
    } catch {
      if (!canApplyStoreResponse(operation, surface, environment)) return false;
      clear();
      state.message = "";
      state.actionError = revoked
        ? "The previous pairing was removed, but a new connection link could not be created. Connect again to continue."
        : "The previous pairing could not be removed. No new connection was created. Refresh status and try again.";
      return false;
    } finally {
      finishRequest(operation);
    }
  }
  function markLaunchRequested() {
    if (!storeInvitationIsCurrent(state.windowsStoreInvitation)) return;
    state.windowsStoreAttempt = { phase: "waiting", expiresAt: state.windowsStoreInvitation.expiresAt };
    // Leave the anchor intact until the browser has dispatched its native protocol.
    setTimeout(notify, 0);
  }
  return { connectWindowsStore, beginWindowsStoreRepair, cancelWindowsStoreRepair, confirmWindowsStoreRepair, markLaunchRequested, clear };
}
