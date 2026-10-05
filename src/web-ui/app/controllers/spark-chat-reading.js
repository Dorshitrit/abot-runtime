export function visibleSparkMessageIds({ messages, rows, bounds }) {
  const eligible = new Set(messages
    .filter((message) => message.role === "assistant" && !message.streaming && message.persistedMessageId != null)
    .map((message) => String(message.id)));
  return rows.filter((row) => eligible.has(row.id) && row.bottom > bounds.top && row.top < bounds.bottom)
    .map((row) => row.id);
}

export function createSparkChatReading({
  dom, getMessages, getEnvironmentId, isOpen, client, onReadState,
  documentRoot = document, viewport = window, onError = () => {},
}) {
  let unread = [];
  let readGeneration;
  let readAvailable = false;
  let anchor;
  let opening = false;
  let readReady = false;
  let follow = true;
  let top = 0;
  let scheduled = false;
  let revision = 0;
  const inFlight = new Set();

  function isActive() {
    if (!isOpen()) return false;
    if (documentRoot.visibilityState !== "visible") return false;
    return documentRoot.hasFocus();
  }
  function updateJump() {
    dom.jumpToLatestButton.hidden = follow || dom.messagesList.scrollHeight <= dom.messagesList.clientHeight + 24;
  }
  function nearEnd() {
    return dom.messagesList.scrollHeight - dom.messagesList.scrollTop - dom.messagesList.clientHeight < 32;
  }
  async function markVisible() {
    if (!readReady || !isActive()) return;
    if (!readAvailable) return;
    const bounds = dom.messagesList.getBoundingClientRect();
    const rows = [...dom.messagesList.querySelectorAll("[data-message-id]")].map((node) => ({
      id: node.dataset.messageId, ...rectangle(node.getBoundingClientRect()),
    }));
    const ids = visibleSparkMessageIds({ messages: getMessages(), rows, bounds })
      .filter((id) => unread.includes(id) && !inFlight.has(id));
    if (!ids.length) return;
    const environmentId = getEnvironmentId();
    const savedRevision = revision;
    const observedUnreadIds = [...unread];
    const visibleMessages = getMessages().filter((message) => ids.includes(String(message.id)))
      .map((message) => ({ id: message.persistedMessageId, createdAt: message.createdAt, requestId: message.requestId || null }));
    ids.forEach((id) => inFlight.add(id));
    try {
      const result = await client.markSparkMessagesRead({ visibleMessageIds: ids, visibleMessages, readGeneration }, environmentId);
      if (savedRevision !== revision || environmentId !== getEnvironmentId()) return;
      onReadState(result.readState, { acknowledgedIds: ids, observedUnreadIds });
    } catch (error) {
      if (savedRevision === revision) onError(error);
    } finally {
      if (savedRevision === revision) ids.forEach((id) => inFlight.delete(id));
    }
  }
  function rectangle(bounds) { return { top: bounds.top, bottom: bounds.bottom }; }
  function scheduleRead() {
    if (scheduled) return;
    scheduled = true;
    viewport.requestAnimationFrame(() => { scheduled = false; void markVisible(); });
  }
  function messageNode(id) {
    return [...dom.messagesList.querySelectorAll("[data-message-id]")].find((node) => node.dataset.messageId === id);
  }
  function applyAnchorSpace() {
    const node = anchor && messageNode(anchor);
    if (!node) return;
    const bounds = dom.messagesList.getBoundingClientRect();
    const nodeBounds = node.getBoundingClientRect();
    const remaining = dom.messagesList.scrollHeight - (dom.messagesList.scrollTop + nodeBounds.top - bounds.top);
    const spacer = documentRoot.createElement("div");
    spacer.className = "spark-reading-spacer";
    spacer.setAttribute("aria-hidden", "true");
    spacer.style.height = `${Math.max(0, dom.messagesList.clientHeight - remaining)}px`;
    dom.messagesList.append(spacer);
    return { nodeBounds, bounds };
  }
  function applyOpeningAnchor() {
    const position = applyAnchorSpace();
    if (!position) {
      dom.messagesList.scrollTop = dom.messagesList.scrollHeight;
      follow = true;
      return;
    }
    const { nodeBounds, bounds } = position;
    dom.messagesList.scrollTop += nodeBounds.top - bounds.top;
    follow = false;
  }
  function renderDivider() {
    const node = anchor && messageNode(anchor);
    if (!node) return;
    const divider = documentRoot.createElement("div");
    divider.className = "spark-new-messages";
    divider.textContent = "New messages";
    node.before(divider);
  }
  function afterRender() {
    renderDivider();
    if (!isOpen()) return;
    if (opening) {
      opening = false;
      applyOpeningAnchor();
    } else if (follow) {
      dom.messagesList.scrollTop = dom.messagesList.scrollHeight;
    } else {
      applyAnchorSpace();
      dom.messagesList.scrollTop = top;
    }
    top = dom.messagesList.scrollTop;
    readReady = true;
    updateJump();
    scheduleRead();
  }
  dom.messagesList.addEventListener("scroll", () => {
    top = dom.messagesList.scrollTop;
    follow = nearEnd();
    updateJump(); scheduleRead();
  }, { passive: true });
  documentRoot.addEventListener("visibilitychange", scheduleRead);
  viewport.addEventListener("focus", scheduleRead);
  return {
    afterRender,
    onLayoutChange() {
      if (!isOpen()) return;
      if (follow) dom.messagesList.scrollTop = dom.messagesList.scrollHeight;
      else dom.messagesList.scrollTop = top;
      updateJump(); scheduleRead();
    },
    toEnd() { follow = true; anchor = undefined; dom.messagesList.scrollTop = dom.messagesList.scrollHeight; top = dom.messagesList.scrollTop; updateJump(); scheduleRead(); },
    open(targetId) { anchor = targetId || unread[0]; opening = true; readReady = false; },
    setReadState(readState) {
      readAvailable = readState?.readStateStatus !== "unavailable";
      if (readGeneration !== readState?.readGeneration) { revision += 1; inFlight.clear(); }
      unread = (readState?.unreadMessageIds || []).map(String); readGeneration = readState?.readGeneration;
    },
    scheduleRead,
    reset() { revision += 1; unread = []; inFlight.clear(); anchor = undefined; opening = false; readReady = false; follow = true; top = 0; },
  };
}
