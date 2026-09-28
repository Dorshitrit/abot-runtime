const MAX_SEEN_DELIVERIES = 100;

function isProposalDelivery(message, environmentId) {
  if (message?.type !== "learning.changed") return false;
  if (message.environmentId !== environmentId) return false;
  if (message.event?.type !== "proposal_delivered") return false;
  return [message.event.proposalId, message.event.sessionId].every(
    (id) =>
      typeof id === "string" &&
      id.length > 0 &&
      id.length <= 256 &&
      !/[\u0000-\u001f\u007f]/u.test(id),
  );
}

/** Live deliveries alone announce themselves. Restored snapshots never produce a toast. */
export function createProposalNotifications({
  getEnvironmentId,
  openSession,
  getDocument = () => document,
}) {
  const seen = new Set();
  let root;
  let current;
  let ownerDocument;

  function syncVisibility() {
    if (!root) return;
    root.hidden = !current || ownerDocument.visibilityState === "hidden";
  }

  function hide() {
    current = undefined;
    if (root) root.hidden = true;
  }

  async function handleClick(event) {
    const button = event.target.closest("button");
    if (!button || !root?.contains(button)) return;
    if (button.matches("[data-proposal-notice-close]")) {
      hide();
      return;
    }
    if (!button.matches("[data-proposal-notice-open]")) return;
    const proposal = current;
    if (!proposal || proposal.environmentId !== getEnvironmentId()) {
      hide();
      return;
    }
    button.disabled = true;
    try {
      const opened = await openSession(
        proposal.sessionId,
        proposal.environmentId,
      );
      if (current === proposal && opened !== false) hide();
    } catch {
      if (current !== proposal) return;
      root.querySelector("[data-proposal-notice-description]").textContent =
        "The conversation could not be opened. You can also find it in Chats.";
    } finally {
      if (current === proposal) button.disabled = false;
    }
  }

  function mount() {
    if (root) return;
    const doc = getDocument();
    ownerDocument = doc;
    root = doc.createElement("aside");
    root.className = "co-worker-proposal-toast";
    root.setAttribute("role", "status");
    root.setAttribute("aria-live", "polite");
    root.setAttribute("aria-atomic", "true");
    root.addEventListener("click", handleClick);
    doc.addEventListener?.("visibilitychange", syncVisibility);
    doc.body.append(root);
  }

  return Object.freeze({
    handleRealtime(message) {
      const environmentId = getEnvironmentId();
      if (!isProposalDelivery(message, environmentId)) return;
      const key = JSON.stringify([environmentId, message.event.proposalId]);
      if (seen.has(key)) return;
      seen.add(key);
      if (seen.size > MAX_SEEN_DELIVERIES)
        seen.delete(seen.values().next().value);
      mount();
      current = { environmentId, sessionId: message.event.sessionId };
      root.innerHTML = `<div class="co-worker-proposal-toast-copy"><p>ABot Spark has a suggestion</p>
        <span data-proposal-notice-description>A new conversation is ready when you are.</span>
        <button type="button" class="home-text-button" data-proposal-notice-open>Read suggestion ↗</button></div>
        <button type="button" class="home-text-button" data-proposal-notice-close aria-label="Dismiss notification">×</button>`;
      syncVisibility();
    },
    environmentChanged: hide,
    dispose() {
      hide();
      root?.removeEventListener("click", handleClick);
      ownerDocument?.removeEventListener?.("visibilitychange", syncVisibility);
      root?.remove();
      root = undefined;
    },
  });
}
