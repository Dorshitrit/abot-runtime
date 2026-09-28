import { escapeAttribute, escapeHtml } from "../../lib/text-format.js";
const renderKeys = new WeakMap();

export function renderLearningProposals(root, snapshot, { limit = 3 } = {}) {
  const container = root.querySelector("[data-learning-proposals]");
  if (!container) return;
  const proposals = [...(snapshot.status?.proactive?.proposals ?? [])].reverse().filter((item) => item.status === "delivered").slice(0, limit);
  const key = JSON.stringify([snapshot.environmentId, proposals, snapshot.dismissingProposalId, snapshot.proposalError]);
  if (renderKeys.get(container) === key) return;
  renderKeys.set(container, key);
  container.innerHTML = proposals.map((item) => `<article class="co-worker-proposal"><div class="co-worker-proposal-icon" aria-hidden="true">✦</div><div><span class="co-worker-eyebrow">ABot Spark · conversation ready</span><h4 dir="auto">${escapeHtml(item.title)}</h4><p dir="auto">${escapeHtml(item.message)}</p><div class="co-worker-proposal-actions"><button type="button" data-learning-proposal-open="${escapeAttribute(item.id)}">Open conversation ↗</button><button type="button" data-learning-proposal-dismiss="${escapeAttribute(item.id)}"${snapshot.dismissingProposalId ? " disabled" : ""}>Not now</button></div></div></article>`).join("") + (snapshot.proposalError ? `<p role="status">${escapeHtml(snapshot.proposalError)}</p>` : "");
}

export function handleProposalClick(root, event, actions = {}) {
  const open = event.target.closest("[data-learning-proposal-open]");
  if (open && root.contains(open)) { void actions.openProposal?.(open.dataset.learningProposalOpen); return true; }
  const dismiss = event.target.closest("[data-learning-proposal-dismiss]");
  if (dismiss && root.contains(dismiss)) {
    if (!dismiss.disabled) void actions.dismissProposal?.(dismiss.dataset.learningProposalDismiss);
    return true;
  }
  return false;
}
