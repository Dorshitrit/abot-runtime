import {
  buildEventTimelineEntries,
  eventTone,
  formatEventDetail,
  formatEventLabel,
} from "../lib/event-presentation.js";

function textOf(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function countOf(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function eventRequestId(event) {
  return textOf(event?.requestId);
}

function progressStatus(value) {
  const status = textOf(value).trim().toLowerCase();
  if (status === "done" || status === "completed") return "done";
  if (status === "in_progress" || status === "active") return "active";
  if (status === "blocked" || status === "failed") return "failed";
  if (status === "superseded") return "muted";
  return "pending";
}

function presentEvent(event) {
  const isPresentedEvent = Boolean(event?.eventName || event?.key);
  return {
    ...event,
    eventName: textOf(
      event?.eventName || event?.name || event?.rawType || event?.type,
    ),
    name: isPresentedEvent
      ? textOf(event.name, "Event")
      : formatEventLabel(event),
    summary: isPresentedEvent
      ? textOf(event.summary)
      : formatEventDetail(event),
    tone: textOf(event?.tone) || eventTone(event),
    count: Math.max(1, countOf(event?.count, 1)),
  };
}

function normalizeProgress(taskProgress, requestId) {
  if (!taskProgress || textOf(taskProgress.requestId) !== requestId) {
    return null;
  }
  const items = Array.isArray(taskProgress.items)
    ? taskProgress.items.flatMap((item) => {
        const title = textOf(item?.title).trim();
        if (!title) return [];
        return [
          {
            id: textOf(item?.id),
            title,
            status: progressStatus(item?.status),
            order: countOf(item?.order),
          },
        ];
      })
    : [];
  const completed = Math.max(
    countOf(taskProgress.completed),
    items.filter((item) => item.status === "done").length,
  );
  const total = Math.max(countOf(taskProgress.total), items.length);
  return {
    summary: textOf(taskProgress.summary).trim(),
    activeItem: textOf(taskProgress.activeItem).trim(),
    requestSatisfaction: textOf(taskProgress.requestSatisfaction).trim(),
    completed,
    total,
    items,
  };
}

function normalizeContextWindow(contextWindow, requestId) {
  if (!contextWindow || textOf(contextWindow.requestId) !== requestId) {
    return null;
  }
  const snapshot = contextWindow.snapshot;
  const contextWindowTokens = countOf(snapshot?.contextWindowTokens);
  const estimatedInputTokens = countOf(snapshot?.estimatedInputTokens);
  const usedContextPercent = countOf(snapshot?.usedContextPercent, -1);
  if (contextWindowTokens <= 0 || usedContextPercent < 0) return null;
  const providerUsage = contextWindow.providerUsage;
  const providerUsageMatches =
    providerUsage &&
    textOf(providerUsage.invocationId) === textOf(snapshot.invocationId);
  const compaction = contextWindow.lastCompaction;
  return {
    invocationId: textOf(snapshot.invocationId),
    modelStep: textOf(snapshot.modelStep),
    profileId: textOf(snapshot.profileId),
    measurement: textOf(snapshot.measurement, "estimated"),
    source: textOf(snapshot.source, "runtime_token_estimator"),
    admissionOutcome: textOf(snapshot.admissionOutcome),
    contextWindowTokens,
    estimatedInputTokens,
    remainingContextTokens: countOf(snapshot.remainingContextTokens),
    usedContextPercent,
    remainingContextPercent: countOf(
      snapshot.remainingContextPercent,
      Math.max(0, 100 - usedContextPercent),
    ),
    compactionTriggerPercent: countOf(snapshot.compactionTriggerPercent, 70),
    outputReserveTokens: countOf(snapshot.outputReserveTokens),
    safetyReserveTokens: countOf(snapshot.safetyReserveTokens),
    attachmentReserveTokens: countOf(snapshot.attachmentReserveTokens),
    formatReserveTokens: countOf(snapshot.formatReserveTokens),
    providerUsage: providerUsageMatches
      ? {
          inputTokens: countOf(providerUsage.inputTokens),
          outputTokens: countOf(providerUsage.outputTokens),
          totalTokens: countOf(providerUsage.totalTokens),
          source: textOf(providerUsage.source, "provider_reported"),
        }
      : null,
    compaction:
      Number.isFinite(compaction?.beforePercent) &&
      Number.isFinite(compaction?.afterPercent)
        ? {
            beforePercent: compaction.beforePercent,
            afterPercent: compaction.afterPercent,
          }
        : null,
  };
}

export function buildConversationActivityModel({
  requestId,
  events = [],
  taskProgress = null,
  contextWindow = null,
  streaming = false,
} = {}) {
  const normalizedRequestId = textOf(requestId).trim();
  if (!normalizedRequestId) {
    return {
      requestId: "",
      events: [],
      progress: null,
      contextWindow: null,
      eventCount: 0,
      toolCount: 0,
      failureCount: 0,
      latestLabel: "",
      currentLabel: "",
      openByDefault: false,
      hasContent: false,
    };
  }

  const scopedEvents = Array.isArray(events)
    ? events
        .filter((event) => eventRequestId(event) === normalizedRequestId)
        .map(presentEvent)
    : [];
  const timeline = buildEventTimelineEntries(scopedEvents);
  const progress = normalizeProgress(taskProgress, normalizedRequestId);
  const contextWindowModel = normalizeContextWindow(
    contextWindow,
    normalizedRequestId,
  );
  const eventCount = timeline.reduce(
    (total, event) => total + Math.max(1, countOf(event.count, 1)),
    0,
  );
  const toolCount = timeline.reduce((total, event) => {
    const eventName = textOf(event.eventName || event.rawType || event.type);
    return eventName.startsWith("tool.")
      ? total + Math.max(1, countOf(event.count, 1))
      : total;
  }, 0);
  const failureCount = timeline.reduce(
    (total, event) =>
      event.tone === "failed"
        ? total + Math.max(1, countOf(event.count, 1))
        : total,
    0,
  );

  return {
    requestId: normalizedRequestId,
    events: timeline,
    progress,
    contextWindow: contextWindowModel,
    eventCount,
    toolCount,
    failureCount,
    latestLabel: textOf(timeline.at(-1)?.name),
    currentLabel: streaming
      ? progress?.activeItem ||
        textOf(timeline.at(-1)?.name) ||
        progress?.summary ||
        "Working"
      : "",
    openByDefault: Boolean(streaming),
    hasContent: Boolean(progress || timeline.length > 0),
  };
}

function appendTextNode(documentRoot, parent, className, text) {
  const node = documentRoot.createElement("span");
  node.className = className;
  node.textContent = text;
  parent.appendChild(node);
  return node;
}

function renderProgress(documentRoot, progress) {
  if (!progress) return null;
  const section = documentRoot.createElement("section");
  section.className = "conversation-activity-progress";

  const header = documentRoot.createElement("div");
  header.className = "conversation-activity-progress-header";
  appendTextNode(
    documentRoot,
    header,
    "conversation-activity-progress-title",
    progress.summary || progress.activeItem || "Task progress",
  );
  if (progress.total > 0) {
    appendTextNode(
      documentRoot,
      header,
      "conversation-activity-progress-count",
      `${Math.min(progress.completed, progress.total)}/${progress.total}`,
    );
  }
  section.appendChild(header);

  if (progress.total > 0) {
    const track = documentRoot.createElement("div");
    track.className = "conversation-activity-progress-track";
    const value = documentRoot.createElement("span");
    value.style.width = `${Math.min(100, (progress.completed / progress.total) * 100)}%`;
    track.appendChild(value);
    section.appendChild(track);
  }

  if (progress.items.length > 0) {
    const list = documentRoot.createElement("ol");
    list.className = "conversation-activity-progress-items";
    for (const item of progress.items) {
      const row = documentRoot.createElement("li");
      row.className = `conversation-activity-progress-item ${item.status}`;
      appendTextNode(
        documentRoot,
        row,
        "conversation-activity-progress-dot",
        "",
      );
      appendTextNode(
        documentRoot,
        row,
        "conversation-activity-progress-label",
        item.title,
      );
      list.appendChild(row);
    }
    section.appendChild(list);
  }
  return section;
}

function compactNumber(value) {
  return new Intl.NumberFormat("en", { notation: "compact" }).format(value);
}

function formatPercent(value) {
  return Number.isInteger(value) ? `${value}%` : `${value.toFixed(1)}%`;
}

function renderContextWindow(documentRoot, contextWindow) {
  if (!contextWindow) return null;
  const section = documentRoot.createElement("section");
  section.className = "conversation-context-window";
  const header = documentRoot.createElement("div");
  header.className = "conversation-context-window-header";
  appendTextNode(
    documentRoot,
    header,
    "conversation-context-window-title",
    "Context window",
  );
  appendTextNode(
    documentRoot,
    header,
    `conversation-context-window-value${
      contextWindow.admissionOutcome === "rejected" ? " rejected" : ""
    }`,
    formatPercent(contextWindow.usedContextPercent),
  );
  section.appendChild(header);

  const track = documentRoot.createElement("div");
  track.className = "conversation-context-window-track";
  const value = documentRoot.createElement("span");
  value.style.width = `${Math.min(100, contextWindow.usedContextPercent)}%`;
  track.appendChild(value);
  section.appendChild(track);

  appendTextNode(
    documentRoot,
    section,
    "conversation-context-window-detail",
    `${compactNumber(contextWindow.estimatedInputTokens)} / ${compactNumber(
      contextWindow.contextWindowTokens,
    )} estimated input tokens · ${formatPercent(
      contextWindow.remainingContextPercent,
    )} left · ${contextWindow.modelStep || contextWindow.profileId}`,
  );
  if (contextWindow.compaction) {
    appendTextNode(
      documentRoot,
      section,
      "conversation-context-window-compaction",
      `Compaction ${formatPercent(
        contextWindow.compaction.beforePercent,
      )} → ${formatPercent(contextWindow.compaction.afterPercent)}`,
    );
  }
  if (contextWindow.providerUsage) {
    appendTextNode(
      documentRoot,
      section,
      "conversation-context-window-provider",
      `Provider reported ${compactNumber(
        contextWindow.providerUsage.inputTokens,
      )} input · ${compactNumber(
        contextWindow.providerUsage.outputTokens,
      )} output tokens`,
    );
  }
  return section;
}

function renderTimeline(documentRoot, events) {
  const timeline = documentRoot.createElement("div");
  timeline.className = "conversation-activity-timeline";
  for (const event of events) {
    const row = documentRoot.createElement("div");
    row.className = `conversation-activity-event ${event.tone || "active"}`;

    const marker = documentRoot.createElement("span");
    marker.className = "conversation-activity-event-marker";
    marker.setAttribute("aria-hidden", "true");
    row.appendChild(marker);

    const content = documentRoot.createElement("div");
    content.className = "conversation-activity-event-content";
    const title = documentRoot.createElement("div");
    title.className = "conversation-activity-event-title";
    appendTextNode(
      documentRoot,
      title,
      "conversation-activity-event-name",
      event.name || "Event",
    );
    if (event.count > 1) {
      appendTextNode(
        documentRoot,
        title,
        "conversation-activity-event-count",
        `x${event.count}`,
      );
    }
    content.appendChild(title);
    if (event.summary) {
      appendTextNode(
        documentRoot,
        content,
        "conversation-activity-event-detail",
        event.summary,
      );
    }
    row.appendChild(content);
    timeline.appendChild(row);
  }
  return timeline;
}

export function pinConversationActivityToLatest({
  details,
  body,
  streaming,
} = {}) {
  if (!streaming || !details?.open || !body) return false;
  body.scrollTop = Number(body.scrollHeight || 0);
  return true;
}

export function createConversationActivity({ documentRoot = document } = {}) {
  const manuallyCollapsedStreamingRequests = new Set();
  const manuallyExpandedCompletedRequests = new Set();

  function createNode(input = {}) {
    const model = buildConversationActivityModel(input);
    if (!model.hasContent) return null;

    const details = documentRoot.createElement("details");
    details.className = "conversation-activity";
    details.dataset.requestId = model.requestId;
    details.open = model.openByDefault
      ? !manuallyCollapsedStreamingRequests.has(model.requestId)
      : manuallyExpandedCompletedRequests.has(model.requestId);

    const summary = documentRoot.createElement("summary");
    summary.className = "conversation-activity-summary";
    const heading = documentRoot.createElement("span");
    heading.className = "conversation-activity-heading";
    appendTextNode(documentRoot, heading, "conversation-activity-chevron", "");
    appendTextNode(
      documentRoot,
      heading,
      "conversation-activity-title",
      model.failureCount > 0 ? "Activity needs attention" : "Activity",
    );
    summary.appendChild(heading);

    if (model.currentLabel) {
      appendTextNode(
        documentRoot,
        summary,
        "conversation-activity-current",
        model.currentLabel,
      );
    }

    const facts = [];
    if (model.progress?.total > 0) {
      facts.push(
        `${Math.min(model.progress.completed, model.progress.total)}/${model.progress.total} steps`,
      );
    }
    if (model.toolCount > 0) {
      facts.push(`${model.toolCount} tool${model.toolCount === 1 ? "" : "s"}`);
    }
    if (model.failureCount > 0) facts.push(`${model.failureCount} failed`);
    if (facts.length === 0 && model.eventCount > 0) {
      facts.push(`${model.eventCount} events`);
    }
    appendTextNode(
      documentRoot,
      summary,
      `conversation-activity-facts${model.failureCount > 0 ? " failed" : ""}`,
      facts.join(" · "),
    );
    details.appendChild(summary);

    const body = documentRoot.createElement("div");
    body.className = "conversation-activity-body";
    const progress = renderProgress(documentRoot, model.progress);
    if (progress) body.appendChild(progress);
    if (model.events.length > 0) {
      body.appendChild(renderTimeline(documentRoot, model.events));
    }
    details.appendChild(body);

    const pinToLatest = () =>
      pinConversationActivityToLatest({
        details,
        body,
        streaming: model.openByDefault,
      });
    const schedulePinToLatest = () => {
      const animationFrame = documentRoot.defaultView?.requestAnimationFrame;
      if (typeof animationFrame === "function") {
        animationFrame.call(documentRoot.defaultView, pinToLatest);
      } else {
        queueMicrotask(pinToLatest);
      }
    };
    schedulePinToLatest();

    details.addEventListener("toggle", () => {
      if (model.openByDefault) {
        if (details.open) {
          manuallyCollapsedStreamingRequests.delete(model.requestId);
        } else {
          manuallyCollapsedStreamingRequests.add(model.requestId);
        }
      } else {
        if (details.open) {
          manuallyExpandedCompletedRequests.add(model.requestId);
        } else {
          manuallyExpandedCompletedRequests.delete(model.requestId);
        }
      }
      if (details.open) schedulePinToLatest();
    });
    return details;
  }

  function forget(requestId) {
    const normalizedRequestId = textOf(requestId);
    manuallyCollapsedStreamingRequests.delete(normalizedRequestId);
    manuallyExpandedCompletedRequests.delete(normalizedRequestId);
  }

  function reset() {
    manuallyCollapsedStreamingRequests.clear();
    manuallyExpandedCompletedRequests.clear();
  }

  return { createNode, forget, reset };
}

export function createConversationContextWindow({
  documentRoot = document,
} = {}) {
  return {
    createNode(input = {}) {
      const model = buildConversationActivityModel(input);
      return renderContextWindow(documentRoot, model.contextWindow);
    },
  };
}
