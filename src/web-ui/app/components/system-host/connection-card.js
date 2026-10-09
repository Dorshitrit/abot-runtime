import { escapeHtml } from "../../lib/text-format.js";

export function renderComputerMetadata(snapshot, disabled = false) {
  const identity = snapshot?.identity || {};
  const os = { windows: "Windows", macos: "macOS", linux: "Linux" }[identity.os] || identity.os;
  const summary = [identity.name, os, identity.user]
    .filter((value) => typeof value === "string" && value.length > 0).join(" · ");
  if (!summary && !snapshot?.paired) return "";
  return `<div class="system-host-card-computer"><span>${escapeHtml(summary)}</span>${snapshot?.paired ? `<button type="button" data-system-host-revoke title="Disconnect this computer. Saved insights are kept." ${disabled ? "disabled" : ""}>Remove this computer</button>` : ""}</div>`;
}

function renderConnectionStatus(status, ready, compact = false) {
  return `<span class="system-host-card-status" role="status" ${compact ? `aria-label="${escapeHtml(status)}"` : ""} data-tone="${ready ? "ready" : "unavailable"}"><i aria-hidden="true"></i>${compact ? "" : escapeHtml(status)}</span>`;
}

/** Platform actions are supplied by their existing owners; this module renders the shared layout. */
export function renderConnectionCard({
  title, status, ready, disabled = false, compact = false, description = "",
  actions = "", help = "", metadata = "", error = "", message = "", details = "", attributes = "",
}) {
  if (compact) return `<section class="system-host-panel system-host-card system-host-card-ready" aria-label="Computer access" ${attributes}>
    <h2 class="system-host-card-ready-title">${renderConnectionStatus(status, ready, true)}${escapeHtml(title)}</h2>
    ${metadata}
    ${details}
  </section>`;
  return `<section class="system-host-panel system-host-card" aria-label="Computer access" aria-busy="${disabled ? "true" : "false"}" ${attributes}>
    <div class="system-host-card-heading"><h2>${escapeHtml(title)}</h2>${renderConnectionStatus(status, ready)}</div>
    ${description ? `<p class="system-host-card-description">${escapeHtml(description)}</p>` : ""}
    ${actions ? `<div class="system-host-card-action">${actions}</div>` : ""}
    ${help ? `<p class="system-host-card-hint">${escapeHtml(help)}</p>` : ""}
    ${error || message ? `<p class="${error ? "error-text" : "system-host-card-message"}" role="${error ? "alert" : "status"}" aria-live="polite">${escapeHtml(error || message)}</p>` : ""}
    ${metadata}
    ${details}
  </section>`;
}
