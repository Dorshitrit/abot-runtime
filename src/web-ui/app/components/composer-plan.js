const STATUS_LABELS = {
  pending: "Pending",
  active: "In progress",
  done: "Completed",
  blocked: "Blocked",
  superseded: "Superseded",
};

const STATUS_SYMBOLS = {
  pending: "○",
  active: "◌",
  done: "✓",
  blocked: "×",
  superseded: "−",
};

export function createComposerPlan({
  container,
  documentRoot = globalThis.document,
} = {}) {
  if (!container || !documentRoot) return { render() {}, reset() {} };

  function element(tag, className, value = "") {
    const node = documentRoot.createElement(tag);
    node.className = className;
    node.textContent = value;
    return node;
  }

  const details = element("details", "composer-plan-details");
  const summary = element("summary", "composer-plan-toggle");
  const label = element("span", "composer-plan-label", "Planning");
  const preview = element("span", "composer-plan-preview");
  preview.setAttribute("dir", "auto");
  const previewIcon = element("span", "composer-plan-status");
  previewIcon.setAttribute("aria-hidden", "true");
  const chevron = element("span", "composer-plan-chevron", "⌄");
  chevron.setAttribute("aria-hidden", "true");
  summary.append(previewIcon, label, preview, chevron);

  const body = element("div", "composer-plan-body");
  const header = element("div", "composer-plan-header");
  const title = element("p", "composer-plan-title");
  title.setAttribute("dir", "auto");
  const counter = element("span", "composer-plan-counter");
  header.append(title, counter);
  const list = element("ol", "composer-plan-items");
  const placeholder = element(
    "p",
    "composer-plan-placeholder",
    "Preparing tasks...",
  );
  body.append(header, list, placeholder);
  details.append(summary, body);
  container.classList.add("composer-plan");
  container.replaceChildren(details);
  let currentTurnKey = "";
  let renderedItems = "";

  function reset() {
    container.hidden = true;
    container.dataset.requestId = "";
    details.open = false;
    body.scrollTop = 0;
    currentTurnKey = "";
    renderedItems = "";
    preview.textContent = "";
    title.textContent = "";
    counter.textContent = "";
    list.replaceChildren();
  }

  function renderItems(items) {
    const signature = JSON.stringify(items);
    if (signature === renderedItems) return;
    const scrollTop = body.scrollTop;
    const rows = items.map((item) => {
      const row = element("li", `composer-plan-item is-${item.status}`);
      row.dataset.itemId = item.id;
      const icon = element(
        "span",
        "composer-plan-status",
        STATUS_SYMBOLS[item.status],
      );
      icon.setAttribute("aria-hidden", "true");
      const itemTitle = element("span", "composer-plan-item-title", item.title);
      itemTitle.setAttribute("dir", "auto");
      const status = element(
        "span",
        "composer-plan-item-status",
        STATUS_LABELS[item.status],
      );
      row.append(icon, itemTitle, status);
      return row;
    });
    list.replaceChildren(...rows);
    body.scrollTop = scrollTop;
    renderedItems = signature;
  }

  function render(model) {
    if (!model) {
      reset();
      return;
    }
    if (currentTurnKey !== model.turnKey) {
      details.open = false;
      body.scrollTop = 0;
      currentTurnKey = model.turnKey;
    }
    container.hidden = false;
    container.dataset.requestId = model.requestId;
    preview.textContent = model.preview;
    previewIcon.className = `composer-plan-status is-${model.previewStatus}`;
    previewIcon.textContent = STATUS_SYMBOLS[model.previewStatus];
    title.textContent = model.summary;
    title.hidden = !model.summary;
    counter.textContent = `${model.completed}/${model.total} completed`;
    counter.hidden = model.total === 0;
    header.hidden = !model.summary && model.total === 0;
    list.hidden = model.items.length === 0;
    placeholder.hidden = model.items.length > 0;
    renderItems(model.items);
  }

  reset();
  return { render, reset };
}
