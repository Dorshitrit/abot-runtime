import { buildConversationStatus } from "../../lib/conversation-status-model.js";

function isStreamingSparkAssistant(message, requestId) {
  if (message.role !== "assistant") return false;
  if (message.requestId !== requestId) return false;
  return message.streaming === true;
}

/** Both mascot locations project the conversation's existing activity state. */
export function createSparkMascotActivity({ state, dom, isConnected }) {
  function render() {
    const requestId = state.activeRequestId;
    const model = buildConversationStatus({
      requestId,
      streaming: state.messages.some((message) => isStreamingSparkAssistant(message, requestId)),
      connected: isConnected(),
      events: state.events,
      contextWindow: state.contextWindowByRequest.get(requestId),
    });
    const working = model?.animate === true;
    for (const mascot of [dom.launcherButton, dom.mascotButton]) {
      mascot.classList.toggle("spark-is-working", working);
      mascot.setAttribute("aria-description", working ? "SPARK is working." : "");
    }
  }
  return { render };
}
