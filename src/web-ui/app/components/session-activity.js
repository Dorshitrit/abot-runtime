import { escapeAttribute } from "../lib/text-format.js";

export function sessionActivityMarkup(sessionId, working) {
  return `<span class="session-working-indicator" data-session-id="${escapeAttribute(sessionId)}" role="img" title="ABot is working" aria-label="ABot is working"${working ? "" : " hidden"}></span>`;
}

export function updateSessionActivity(root, isWorking) {
  for (const indicator of root.querySelectorAll(".session-working-indicator")) {
    indicator.hidden = !isWorking(indicator.dataset.sessionId);
  }
}
