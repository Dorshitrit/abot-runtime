export function createConversationRoleHistory({
  documentRoot = document,
  kind,
  textClassName,
  ariaLabel,
}) {
  const requests = new Map();
  const prefix = `conversation-role-${kind}`;

  function element(tag, className, text = "") {
    const node = documentRoot.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }

  function requestState(requestId) {
    const existing = requests.get(requestId);
    if (existing) return existing;
    const state = { expanded: new Set(), nodes: new Map() };
    requests.set(requestId, state);
    return state;
  }

  function isCurrentDisclosure(requestId, state, id, node) {
    if (requests.get(requestId) !== state) return false;
    return state.nodes.get(id) === node;
  }

  function historyRow(requestId, state, item) {
    const row = element("li", `${prefix}-row`);
    const details = element("details", `conversation-role-history-item ${prefix}`);
    details.dataset[`${kind}Id`] = item.id;
    details.open = state.expanded.has(item.id);
    state.nodes.set(item.id, details);
    const summary = element("summary", `conversation-role-history-toggle ${prefix}-toggle`);
    const label = element("span", `conversation-role-history-label ${prefix}-label`, item.label);
    const chevron = element("span", `conversation-role-history-chevron ${prefix}-chevron`, "⌄");
    chevron.setAttribute("aria-hidden", "true");
    const text = element("span", `conversation-role-history-text ${textClassName}`, item.text);
    text.setAttribute("dir", "auto");
    summary.append(label, chevron, text);
    details.appendChild(summary);
    details.addEventListener("toggle", () => {
      if (!isCurrentDisclosure(requestId, state, item.id, details)) return;
      if (details.open) {
        state.expanded.add(item.id);
        return;
      }
      state.expanded.delete(item.id);
    });
    row.appendChild(details);
    return row;
  }

  function createNode({ requestId, items = [] }) {
    requests.get(requestId)?.nodes.clear();
    if (items.length === 0) return null;
    const state = requestState(requestId);
    const identities = new Set(items.map((item) => item.id));
    for (const id of state.expanded) {
      if (!identities.has(id)) state.expanded.delete(id);
    }
    const list = element("ol", `conversation-role-history ${prefix}s`);
    list.setAttribute("aria-label", ariaLabel);
    for (const item of items) {
      list.appendChild(historyRow(requestId, state, item));
    }
    return list;
  }

  function forget(requestId) {
    requests.delete(requestId);
  }

  function reset() {
    requests.clear();
  }

  return { createNode, forget, reset };
}
