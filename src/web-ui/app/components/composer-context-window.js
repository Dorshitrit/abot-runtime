import { buildConversationActivityModel } from "./conversation-activity.js";
import { textOf } from "../lib/text-format.js";

export function buildComposerContextWindowModel({
  messages = [],
  activeRequestId = "",
  getActivityForMessage = () => ({}),
} = {}) {
  const activeId = textOf(activeRequestId);
  const contextRequestCandidates = activeId
    ? [...messages].reverse()
    : messages.slice(-1);
  const selectedMessage = contextRequestCandidates.find((message) => {
    const isAssistantRequest =
      message.role === "assistant" && Boolean(textOf(message.requestId));
    if (!isAssistantRequest) return false;
    if (!activeId) return true;
    return message.requestId === activeId;
  });
  if (!selectedMessage) return null;
  const requestId = textOf(selectedMessage.requestId);
  const model = buildConversationActivityModel({
    requestId,
    contextWindow: getActivityForMessage(selectedMessage)?.contextWindow,
  }).contextWindow;
  if (!model) return null;
  return { ...model, requestId };
}

function compactNumber(value) {
  return new Intl.NumberFormat("en", { notation: "compact" }).format(value);
}

function formatPercent(value) {
  return Number.isInteger(value) ? `${value}%` : `${value.toFixed(1)}%`;
}

export function createComposerContextWindow({
  container,
  documentRoot = document,
}) {
  const button = documentRoot.createElement("button");
  button.type = "button";
  button.className = "composer-context-window-button";
  button.setAttribute("aria-label", "Context window");
  button.setAttribute("aria-describedby", "composerContextWindowTooltip");

  const ring = documentRoot.createElement("span");
  ring.className = "composer-context-window-ring";
  ring.setAttribute("aria-hidden", "true");
  button.appendChild(ring);

  const tooltip = documentRoot.createElement("div");
  tooltip.id = "composerContextWindowTooltip";
  tooltip.className = "composer-context-window-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.hidden = true;
  const header = documentRoot.createElement("div");
  header.className = "composer-context-window-header";
  const title = documentRoot.createElement("span");
  title.textContent = "Context window";
  const percentage = documentRoot.createElement("span");
  percentage.className = "composer-context-window-percentage";
  header.append(title, percentage);
  const detail = documentRoot.createElement("div");
  const compaction = documentRoot.createElement("div");
  compaction.className = "composer-context-window-compaction";
  const provider = documentRoot.createElement("div");
  tooltip.append(header, detail, compaction, provider);
  container.replaceChildren(button, tooltip);

  function hideDetails() {
    tooltip.hidden = true;
    container.classList.remove("open");
  }

  function showDetails() {
    if (container.hidden) return;
    tooltip.hidden = false;
    container.classList.add("open");
  }

  container.addEventListener("pointerenter", showDetails);
  container.addEventListener("pointerleave", () => {
    if (documentRoot.activeElement === button) return;
    hideDetails();
  });
  button.addEventListener("focus", showDetails);
  button.addEventListener("blur", hideDetails);
  button.addEventListener("click", showDetails);
  documentRoot.addEventListener(
    "keydown",
    (event) => {
      if (tooltip.hidden) return;
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      hideDetails();
    },
    true,
  );
  documentRoot.addEventListener("pointerdown", (event) => {
    if (container.contains(event.target)) return;
    hideDetails();
  });

  function reset() {
    hideDetails();
    container.hidden = true;
    container.dataset.requestId = "";
    container.classList.remove("rejected");
    ring.style.setProperty("--context-used", "0%");
    button.setAttribute("aria-label", "Context window");
    percentage.textContent = "";
    detail.textContent = "";
    compaction.textContent = "";
    provider.textContent = "";
  }

  function render(model) {
    if (!model) {
      reset();
      return;
    }
    container.hidden = false;
    container.dataset.requestId = model.requestId;
    container.classList.toggle(
      "rejected",
      model.admissionOutcome === "rejected",
    );
    const usedPercent = formatPercent(model.usedContextPercent);
    button.setAttribute("aria-label", `Context window: ${usedPercent} used`);
    ring.style.setProperty(
      "--context-used",
      `${Math.max(0, Math.min(100, model.usedContextPercent))}%`,
    );
    percentage.textContent = usedPercent;
    detail.textContent = `${compactNumber(model.estimatedInputTokens)} / ${compactNumber(
      model.contextWindowTokens,
    )} estimated input tokens · ${formatPercent(model.remainingContextPercent)} left · ${
      model.modelStep || model.profileId
    }`;
    compaction.hidden = !model.compaction;
    compaction.textContent = model.compaction
      ? `Compaction ${formatPercent(model.compaction.beforePercent)} → ${formatPercent(model.compaction.afterPercent)}`
      : "";
    provider.hidden = !model.providerUsage;
    provider.textContent = model.providerUsage
      ? `Provider reported ${compactNumber(model.providerUsage.inputTokens)} input · ${compactNumber(model.providerUsage.outputTokens)} output tokens`
      : "";
  }

  reset();
  return { render, reset };
}
