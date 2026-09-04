function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function canonicalCount(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function itemStatus(value) {
  const status = text(value).toLowerCase();
  if (status === "done" || status === "completed") return "done";
  if (status === "in_progress" || status === "active") return "active";
  if (status === "blocked" || status === "failed") return "blocked";
  if (status === "superseded") return "superseded";
  return "pending";
}

function orderedItems(rawItems) {
  if (!Array.isArray(rawItems)) return [];
  return rawItems
    .flatMap((item, index) => {
      const title = text(item?.title);
      if (!title) return [];
      return [
        {
          id: text(item.id) || `item-${index}`,
          title,
          status: itemStatus(item.status),
          order: canonicalCount(item.order, index + 1),
        },
      ];
    })
    .sort((left, right) => left.order - right.order);
}

function hasVisiblePlan(progress, items, summary) {
  return items.length > 0 || Boolean(summary) || progress.hasSignal === true;
}

function previewStatusFor({ activeItem, items, completed, total }) {
  if (activeItem) return "active";
  const countsAreComplete = total > 0 && completed === total;
  const allVisibleItemsDone =
    items.length > 0 && items.every((item) => item.status === "done");
  if (countsAreComplete && allVisibleItemsDone) return "done";
  return "pending";
}

function planForMessage(message, getActivityForMessage) {
  const requestId = text(message.requestId);
  if (!requestId) return null;
  const progress = getActivityForMessage(message)?.taskProgress;
  if (!progress || text(progress.requestId) !== requestId) return null;
  const items = orderedItems(progress.items);
  const summary = text(progress.summary);
  if (!hasVisiblePlan(progress, items, summary)) return null;
  const completed = canonicalCount(
    progress.completed,
    items.filter((item) => item.status === "done").length,
  );
  const total = canonicalCount(progress.total, items.length);
  const activeItem =
    text(progress.activeItem) ||
    items.find((item) => item.status === "active")?.title ||
    "";
  return {
    requestId,
    turnKey: `request:${requestId}`,
    summary,
    items,
    total,
    completed,
    hasSignal: progress.hasSignal === true,
    preview: activeItem || summary || items[0]?.title || "Preparing tasks...",
    previewStatus: previewStatusFor({ activeItem, items, completed, total }),
  };
}

export function buildComposerPlanModel({
  messages = [],
  activeRequestId = "",
  getActivityForMessage = () => ({}),
} = {}) {
  const lastUserIndex = messages.findLastIndex(
    (message) => message.role === "user",
  );
  const assistants = messages
    .slice(lastUserIndex + 1)
    .filter((message) => message.role === "assistant");
  if (assistants.length === 0) {
    const latestUser = messages[lastUserIndex];
    return latestUser
      ? planForMessage(latestUser, getActivityForMessage)
      : null;
  }
  const activeId = text(activeRequestId);
  const activeAssistant = activeId
    ? assistants.findLast((message) => text(message.requestId) === activeId)
    : null;
  if (activeAssistant) {
    return planForMessage(activeAssistant, getActivityForMessage);
  }
  for (const message of [...assistants].reverse()) {
    const plan = planForMessage(message, getActivityForMessage);
    if (plan) return plan;
  }
  return null;
}
