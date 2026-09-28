import { createToolApprovalCard } from "../tool-approval-card.js";
import { formatEventDetail } from "../../lib/event-presentation.js";
import { projectToolActivityEvent } from "../../lib/tool-activity-event.js";
import { textOf } from "../../lib/text-format.js";

const renderedApprovalCards = new WeakMap();
const renderedApprovalViews = new WeakMap();

export function hasPendingDashboardApprovals(snapshot) {
  return Boolean(snapshot.approvals?.length);
}

function hasDashboardApprovalContent(snapshot) {
  if (hasPendingDashboardApprovals(snapshot)) return true;
  if (snapshot.supportsToolApprovals === false) return false;
  return Boolean(snapshot.approvalsError || snapshot.approvalDecisionError);
}

function approvalConversationTitle(approval, sessions = []) {
  const session = sessions.find(
    (candidate) => candidate.id === approval.sessionId,
  );
  return textOf(session?.displayName || session?.title || approval.sessionId);
}

function approvalScopeKey(approval) {
  return JSON.stringify([
    approval.environmentId,
    approval.sessionId,
    approval.requestId,
    approval.approvalId,
  ]);
}

function createHomeApproval(approval, title, onDecision, documentRoot) {
  const section = documentRoot.createElement("section");
  section.className = "home-approval";
  const conversation = documentRoot.createElement("button");
  conversation.type = "button";
  conversation.className = "home-text-button home-approval-conversation";
  conversation.dataset.dashboardAction = "conversation";
  conversation.dataset.sessionId = approval.sessionId;
  conversation.dataset.requestId = approval.requestId;
  conversation.dir = "auto";
  conversation.textContent = title;
  const event = {
    ...approval.event,
    summary: formatEventDetail(approval.event),
    toolActivity: projectToolActivityEvent(approval.event),
  };
  const card = createToolApprovalCard({
    event,
    submitted: approval.submitted === true,
    documentRoot,
    onDecision: (_approvalId, approved) => void onDecision(approval, approved),
  });
  card.querySelector(".approval-message-header").appendChild(conversation);
  section.appendChild(card);
  return section;
}

function reconcileApprovalNodes(root, nodes, retainedCards) {
  const hasMountedCard = retainedCards.some((card) => root.contains(card));
  if (!hasMountedCard) {
    root.replaceChildren(...nodes);
    return;
  }
  const nextNodes = new Set(nodes);
  for (const child of [...root.children]) {
    if (nextNodes.has(child)) continue;
    root.removeChild(child);
  }
  for (const [index, node] of nodes.entries()) {
    const current = root.children[index];
    if (current === node) continue;
    root.insertBefore(node, current || null);
  }
}

export function renderDashboardApprovals({
  root,
  snapshot,
  onDecision,
  documentRoot = document,
}) {
  root.hidden = !hasDashboardApprovalContent(snapshot);
  if (root.hidden) {
    root.replaceChildren();
    renderedApprovalCards.delete(root);
    renderedApprovalViews.delete(root);
    return;
  }
  const signature = JSON.stringify([
    snapshot.loadingApprovals,
    snapshot.supportsToolApprovals,
    snapshot.approvalDecisionError,
    snapshot.approvalsError,
    (snapshot.approvals || []).map((approval) => [
      approval,
      approvalConversationTitle(approval, snapshot.sessions),
    ]),
  ]);
  const previousView = renderedApprovalViews.get(root);
  if (
    previousView?.signature === signature &&
    previousView.firstChild === root.firstChild
  )
    return;
  const previousCards = renderedApprovalCards.get(root) || new Map();
  const nextCards = new Map();
  const retainedCards = [];
  const nodes = [];
  const header = documentRoot.createElement("header");
  header.className = "home-panel-header";
  const title = documentRoot.createElement("h2");
  title.textContent = "Waiting for approval";
  header.appendChild(title);
  nodes.push(header);

  function feedback(message, alert = false) {
    const paragraph = documentRoot.createElement("p");
    paragraph.className = "home-panel-state";
    paragraph.setAttribute("role", alert ? "alert" : "status");
    paragraph.textContent = message;
    nodes.push(paragraph);
  }

  function publish() {
    reconcileApprovalNodes(root, nodes, retainedCards);
    renderedApprovalCards.set(root, nextCards);
    renderedApprovalViews.set(root, { signature, firstChild: root.firstChild });
  }

  root.setAttribute("aria-busy", String(Boolean(snapshot.loadingApprovals)));
  if (snapshot.supportsToolApprovals === false) {
    feedback(
      "Home approvals are unavailable with this connection. Open the conversation to review pending actions.",
    );
    publish();
    return;
  }
  if (snapshot.approvalDecisionError)
    feedback(snapshot.approvalDecisionError, true);
  if (snapshot.approvalsError)
    feedback(
      "Approvals could not be refreshed. " + snapshot.approvalsError,
      true,
    );
  const approvals = snapshot.approvals || [];
  if (!approvals.length) {
    publish();
    return;
  }
  for (const approval of approvals) {
    const key = approvalScopeKey(approval);
    const title = approvalConversationTitle(approval, snapshot.sessions);
    const signature = JSON.stringify([approval, title]);
    const previous = previousCards.get(key);
    const unchanged = previous?.signature === signature;
    const node = unchanged
      ? previous.node
      : createHomeApproval(approval, title, onDecision, documentRoot);
    if (unchanged) retainedCards.push(node);
    nextCards.set(key, { signature, node });
    nodes.push(node);
  }
  publish();
}
