const ROLE_INITIALS = {
  supervisor: "S",
  planner: "P",
  worker: "W",
  reviewer: "R",
};

export function createConversationRoleCards({ documentRoot = document } = {}) {
  const timelineRequests = new Set();
  const cardsScroll = new Map();
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
      ROLE_INITIALS[role],
    );
    avatar.setAttribute("aria-hidden", "true");
    return avatar;
  }

  function createSummaryNode(cards) {
    if (cards.length === 0) return null;
    const strip = element("span", "conversation-role-summary-strip");
    for (const card of cards) {
      const item = element(
        "span",
        `conversation-role-summary-item is-${card.tone}`,
      );
      item.dataset.role = card.role;
      item.setAttribute("role", "img");
      item.setAttribute("aria-label", card.title);
      item.setAttribute("title", card.title);
      item.appendChild(roleAvatar(card.role));
      strip.appendChild(item);
    }
    return strip;
  }

  function renderCard(card) {
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
      const active = element("span", "conversation-role-active");
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
    if (card.facts.length > 0) {
      const facts = element("ul", "conversation-role-facts");
      for (const fact of card.facts) {
        facts.appendChild(textElement("li", "conversation-role-fact", fact));
      }
      header.appendChild(facts);
    }
    content.appendChild(header);
    if (card.summary) {
      const summary = element("p", "conversation-role-summary");
      summary.append(
        element("span", "conversation-role-action-label", "Latest: "),
        textElement("bdi", "conversation-role-action", card.summary),
      );
      content.appendChild(summary);
    }
    row.appendChild(content);
    return row;
  }

  function isTimeline(requestId) {
    return timelineRequests.has(requestId);
  }

  function bindScroll({ requestId, body, details }) {
    const position = { top: cardsScroll.get(requestId)?.top || 0 };
    cardsScroll.set(requestId, position);
    function ownsVisibleCards() {
      if (cardsScroll.get(requestId) !== position) return false;
      if (!details.open) return false;
      return !isTimeline(requestId);
    }
    body.addEventListener("scroll", () => {
      if (!ownsVisibleCards()) return;
      position.top = body.scrollTop;
    });
    return () => {
      if (!ownsVisibleCards()) return false;
      body.scrollTop = position.top;
      return true;
    };
  }

  function createNode({ requestId, cards, timeline, onViewChange = () => {} }) {
    if (cards.length === 0) return timeline;
    const section = element("div", "conversation-role-view");
    const toolbar = element("div", "conversation-role-toolbar");
    toolbar.appendChild(element("span", "conversation-role-label", "Agents"));
    const toggle = element("button", "conversation-role-toggle");
    toggle.type = "button";
    toolbar.appendChild(toggle);
    const panel = element("div", "conversation-role-panel");
    panel.id = `conversation-role-panel-${++panelSequence}`;
    toggle.setAttribute("aria-controls", panel.id);
    const list = element("ol", "conversation-role-list");
    list.setAttribute("aria-label", "Request agents");
    for (const card of cards) list.appendChild(renderCard(card));
    panel.append(list, timeline);
    section.append(toolbar, panel);

    function updateView() {
      const showTimeline = isTimeline(requestId);
      list.hidden = showTimeline;
      timeline.hidden = !showTimeline;
      section.dataset.view = showTimeline ? "timeline" : "cards";
      toggle.textContent = showTimeline ? "Show agents" : "Show timeline";
    }

    toggle.addEventListener("click", () => {
      if (isTimeline(requestId)) timelineRequests.delete(requestId);
      else timelineRequests.add(requestId);
      const position = cardsScroll.get(requestId);
      if (position) position.top = 0;
      updateView();
      onViewChange();
    });
    updateView();
    return section;
  }

  function forget(requestId) {
    timelineRequests.delete(requestId);
    cardsScroll.delete(requestId);
  }

  function reset() {
    timelineRequests.clear();
    cardsScroll.clear();
  }

  return {
    createNode,
    createSummaryNode,
    isTimeline,
    bindScroll,
    forget,
    reset,
  };
}
