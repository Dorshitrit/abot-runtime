import { createConversationTools } from "./conversation-tools.js";

const ROLE_INITIALS = {
  supervisor: "S",
  planner: "P",
  worker: "W",
  researcher: "Rs",
  reviewer: "R",
};

export function createConversationRoleCards({
  documentRoot = document,
  onOpenFile,
  canOpenFile,
} = {}) {
  const timelineRequests = new Set();
  const timelineToggles = new Map();
  const toolsByRequest = new Map();
  let panelSequence = 0;

  function element(tag, className, text = "") {
    const node = documentRoot.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }

  function textElement(tag, className, text) {
    const node = element(tag, className, text);
    node.setAttribute("dir", "auto");
    return node;
  }

  function roleAvatar(role) {
    const avatar = element(
      "span",
      "conversation-role-avatar",
      ROLE_INITIALS[role] || "•",
    );
    avatar.setAttribute("aria-hidden", "true");
    return avatar;
  }

  function toolsForCard(requestId, cardId) {
    const cards = toolsByRequest.get(requestId) || new Map();
    toolsByRequest.set(requestId, cards);
    const existing = cards.get(cardId);
    if (existing) return existing;
    const tools = createConversationTools({
      documentRoot,
      onOpenFile,
      canOpenFile,
    });
    cards.set(cardId, tools);
    return tools;
  }

  function discardMissingCardTools(requestId, cards) {
    const renderers = toolsByRequest.get(requestId);
    if (!renderers) return;
    const cardIds = new Set(cards.map((card) => card.id));
    for (const [cardId, tools] of renderers) {
      if (cardIds.has(cardId)) continue;
      tools.reset();
      renderers.delete(cardId);
    }
  }

  function renderCard(requestId, card) {
    const row = element("li", `conversation-role-card is-${card.tone}`);
    row.dataset.role = card.role;
    row.dataset.cardId = card.id;
    row.appendChild(roleAvatar(card.role));
    const content = element("div", "conversation-role-content");
    const header = element("div", "conversation-role-header");
    header.appendChild(
      textElement("span", "conversation-role-title", card.title),
    );
    if (card.active) {
      const active = element("span", "conversation-role-active", "Working");
      active.setAttribute("role", "img");
      active.setAttribute("aria-label", "Active role");
      header.appendChild(active);
    }
    header.appendChild(
      textElement(
        "span",
        "conversation-role-responsibility",
        card.responsibility,
      ),
    );
    const hasActivityError = card.tone === "failed";
    if (hasActivityError) {
      header.appendChild(
        element("span", "conversation-role-error", "Activity error"),
      );
    }
    content.appendChild(header);
    const message = element("div", "conversation-role-message");
    if (card.summary) {
      const summary = element("p", "conversation-role-summary");
      summary.append(
        element("span", "conversation-role-action-label", "Latest: "),
        textElement("bdi", "conversation-role-action", card.summary),
      );
      message.appendChild(summary);
    }
    if (card.facts.length > 0) {
      const facts = element("ul", "conversation-role-facts");
      for (const fact of card.facts) {
        facts.appendChild(textElement("li", "conversation-role-fact", fact));
      }
      message.appendChild(facts);
    }
    const tools = toolsForCard(requestId, card.id).createNode({
      requestId,
      actions: card.toolActions || [],
      embedded: true,
    });
    if (tools) {
      tools.setAttribute("aria-label", `${card.title} tool activity`);
      message.appendChild(tools);
    }
    content.appendChild(message);
    row.appendChild(content);
    return row;
  }

  function isTimeline(requestId) {
    return timelineRequests.has(requestId);
  }

  function createNode({
    requestId,
    cards,
    heading,
    timeline,
    hasTimeline,
    onViewChange = () => {},
  }) {
    discardMissingCardTools(requestId, cards);
    timelineToggles.delete(requestId);
    if (!hasTimeline) timelineRequests.delete(requestId);
    if (cards.length === 0) return timeline;
    const section = element("div", "conversation-role-view");
    const toolbar = element("div", "conversation-role-toolbar");
    toolbar.appendChild(
      heading || element("span", "conversation-role-label", "Agents"),
    );
    const toggle = element("button", "conversation-role-toggle");
    toggle.type = "button";
    const icon = element("span", "conversation-role-toggle-icon");
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M3 3v10M7 3h6M7 8h6M7 13h6"/><circle cx="3" cy="3" r="1"/><circle cx="3" cy="8" r="1"/><circle cx="3" cy="13" r="1"/></svg>';
    const toggleLabel = element("span", "conversation-role-toggle-label");
    toggle.append(icon, toggleLabel);
    timelineToggles.set(requestId, toggle);
    if (hasTimeline) toolbar.appendChild(toggle);
    const panel = element("div", "conversation-role-panel");
    panel.id = `conversation-role-panel-${++panelSequence}`;
    toggle.setAttribute("aria-controls", panel.id);
    const list = element("ol", "conversation-role-list");
    list.setAttribute("aria-label", "Request agents");
    for (const card of cards) list.appendChild(renderCard(requestId, card));
    panel.append(list, timeline);
    section.append(panel, toolbar);

    function updateView() {
      const showTimeline = isTimeline(requestId);
      list.hidden = showTimeline;
      timeline.hidden = !showTimeline;
      section.dataset.view = showTimeline ? "timeline" : "cards";
      toggleLabel.textContent = showTimeline ? "Show agents" : "Show timeline";
      toggle.setAttribute("aria-pressed", String(showTimeline));
    }

    toggle.addEventListener("click", () => {
      if (timelineToggles.get(requestId) !== toggle) return;
      if (!hasTimeline) return;
      if (isTimeline(requestId)) timelineRequests.delete(requestId);
      else timelineRequests.add(requestId);
      updateView();
      onViewChange();
    });
    updateView();
    return section;
  }

  function forget(requestId) {
    timelineRequests.delete(requestId);
    timelineToggles.delete(requestId);
    const tools = toolsByRequest.get(requestId);
    tools?.forEach((renderer) => renderer.reset());
    toolsByRequest.delete(requestId);
  }

  function reset() {
    timelineRequests.clear();
    timelineToggles.clear();
    for (const tools of toolsByRequest.values()) {
      tools.forEach((renderer) => renderer.reset());
    }
    toolsByRequest.clear();
  }

  return {
    createNode,
    isTimeline,
    forget,
    reset,
  };
}
