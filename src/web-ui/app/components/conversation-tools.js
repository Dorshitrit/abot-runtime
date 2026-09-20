import { createConversationFileAction } from "./conversation-file-action.js";
import { createConversationToolEvidence } from "./conversation-tool-evidence.js";

const STATUS_SYMBOLS = {
  preparing: "◌",
  running: "◌",
  awaiting_approval: "○",
  completed: "✓",
  failed: "×",
  empty: "−",
  unchanged: "−",
  incomplete: "!",
};

function text(value) {
  return typeof value === "string" ? value : "";
}

function hasKnownToolStatus(status) {
  return Object.hasOwn(STATUS_SYMBOLS, status);
}

function canShowToolActivity(requestId, actions) {
  if (!requestId) return false;
  return Array.isArray(actions) && actions.length > 0;
}

function hasToolActionIdentity(action) {
  return Boolean(text(action?.id));
}

function isRepeatedToolAction(count) {
  return Number.isSafeInteger(count) && count > 1;
}

export function createConversationTools({
  documentRoot = document,
  onOpenFile,
  canOpenFile,
} = {}) {
  const requests = new Map();

  function requestState(requestId) {
    const existing = requests.get(requestId);
    if (existing) return existing;
    const state = {
      expanded: new Set(),
      nodes: new Map(),
    };
    requests.set(requestId, state);
    return state;
  }

  function element(tag, className, value = "") {
    const node = documentRoot.createElement(tag);
    node.className = className;
    node.textContent = text(value);
    return node;
  }

  function isolatedText(tag, className, value) {
    const node = element(tag, className, value);
    node.setAttribute("dir", "auto");
    return node;
  }

  function evidenceNotice(action, groups) {
    const notices = [];
    if (action.partial) notices.push("Partial result");
    if (action.previewTruncated) notices.push("Excerpt shortened");
    if (action.legacy) notices.push("Limited recorded details");
    if (!groups && notices.length === 0) {
      return element(
        "p",
        "conversation-tool-unrecorded",
        "No additional details were recorded.",
      );
    }
    if (notices.length === 0) return null;
    return element("p", "conversation-tool-notice", notices.join(" · "));
  }

  function actionTarget(action) {
    const target = isolatedText(
      "bdi",
      "conversation-tool-target",
      action.target,
    );
    target.title = text(action.target);
    return target;
  }

  function actionSummary(action, status, fileAction) {
    const summary = element("summary", "conversation-tool-summary");
    const symbol = element(
      "span",
      "conversation-tool-symbol",
      STATUS_SYMBOLS[status],
    );
    symbol.setAttribute("aria-hidden", "true");
    const description = element("span", "conversation-tool-description");
    description.appendChild(
      isolatedText("bdi", "conversation-tool-title", action.title),
    );
    if (fileAction) description.appendChild(fileAction);
    if (!fileAction && action.target)
      description.appendChild(actionTarget(action));
    summary.append(symbol, description);
    if (isRepeatedToolAction(action.count)) {
      summary.appendChild(
        element("span", "conversation-tool-count", `×${action.count}`),
      );
    }
    summary.appendChild(
      isolatedText("span", "conversation-tool-status", action.statusLabel),
    );
    const chevron = element("span", "conversation-tool-chevron", "⌄");
    chevron.setAttribute("aria-hidden", "true");
    summary.appendChild(chevron);
    return summary;
  }

  function isCurrentDisclosure(requestId, request, actionId, details) {
    if (requests.get(requestId) !== request) return false;
    return request.nodes.get(actionId) === details;
  }

  function actionRow(requestId, request, action) {
    const status = hasKnownToolStatus(action.status)
      ? action.status
      : "incomplete";
    const row = element("li", "conversation-tool-row");
    const details = element("details", `conversation-tool is-${status}`);
    details.dataset.actionId = action.id;
    details.open = request.expanded.has(action.id);
    request.nodes.set(action.id, details);
    const fileAction = createConversationFileAction({
      documentRoot,
      requestId,
      action,
      onOpenFile,
      canOpenFile,
      isCurrentAction: () =>
        isCurrentDisclosure(requestId, request, action.id, details),
    });
    details.appendChild(actionSummary(action, status, fileAction));
    const body = element("div", "conversation-tool-body");
    if (action.intent) {
      body.appendChild(
        isolatedText("p", "conversation-tool-intent", action.intent),
      );
    }
    const groups = createConversationToolEvidence(action, {
      documentRoot,
      hideRepeatedTarget: true,
    });
    if (groups) body.appendChild(groups);
    const notice = evidenceNotice(action, groups);
    if (notice) body.appendChild(notice);
    details.appendChild(body);
    details.addEventListener("toggle", () => {
      if (!isCurrentDisclosure(requestId, request, action.id, details)) return;
      if (details.open) {
        request.expanded.add(action.id);
        return;
      }
      request.expanded.delete(action.id);
    });
    row.appendChild(details);
    return row;
  }

  function createNode({ requestId, actions = [], embedded = false } = {}) {
    const id = text(requestId);
    const currentRequest = requests.get(id);
    currentRequest?.nodes.clear();
    if (!canShowToolActivity(id, actions)) return null;
    const validActions = actions.filter(hasToolActionIdentity);
    if (validActions.length === 0) return null;
    const request = requestState(id);
    const section = element("section", "conversation-tools");
    section.setAttribute("aria-label", "Tool activity");
    section.dataset.requestId = id;
    if (!embedded) {
      section.appendChild(element("h3", "conversation-tools-title", "Tools"));
    }
    const list = element("ol", "conversation-tools-list");
    for (const action of validActions) {
      list.appendChild(actionRow(id, request, action));
    }
    section.appendChild(list);
    return section;
  }

  function forget(requestId) {
    requests.delete(text(requestId));
  }

  function reset() {
    requests.clear();
  }

  return { createNode, forget, reset };
}
