import { buildConversationToolActions } from "../../lib/tool-activity-model.js";
import { buildConversationSources } from "../../lib/web-sources.js";
import { createConversationSources } from "../conversation-sources.js";
import { createConversationFileAction } from "../conversation-file-action.js";

/** Keep useful results and failures without exposing the session event inspector. */
export function createSparkChatResults({ documentRoot = document, onOpenFile, canOpenFile }) {
  const sources = createConversationSources({ documentRoot });
  const currentActions = new Map();
  function createNode({ requestId, events = [], streaming = false }) {
    const scopedEvents = events.filter((event) => event.requestId === requestId);
    const actions = buildConversationToolActions({ requestId, events: scopedEvents, streaming });
    currentActions.set(requestId, actions);
    const node = documentRoot.createElement("div");
    node.className = "spark-chat-results";
    for (const action of actions) {
      const file = createConversationFileAction({
        documentRoot, requestId, action, onOpenFile, canOpenFile,
        isCurrentAction: () => currentActions.get(requestId)?.some((current) =>
          current.id === action.id && JSON.stringify(current.fileReference) === JSON.stringify(action.fileReference)) === true,
      });
      if (file) node.appendChild(file);
      if (!["failed", "incomplete"].includes(action.status) && !action.partial) continue;
      const warning = documentRoot.createElement("p");
      warning.className = "spark-result-warning";
      warning.setAttribute("role", "status");
      const error = action.received.find((field) => field.label === "Error")?.value;
      warning.textContent = error || `${action.title}: ${action.partial ? "Only part of the result is available." : action.statusLabel}`;
      node.appendChild(warning);
    }
    for (const event of scopedEvents) {
      if (event.toolActivity || !["failed", "warning"].includes(event.tone)) continue;
      const warning = documentRoot.createElement("p");
      warning.className = "spark-result-warning";
      warning.setAttribute("role", "status");
      warning.textContent = event.summary || event.name;
      node.appendChild(warning);
    }
    const references = sources.createNode(buildConversationSources(scopedEvents));
    if (references) node.appendChild(references);
    return node.children.length ? node : null;
  }
  return { createNode, reset() { currentActions.clear(); } };
}
