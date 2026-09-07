import {
  buildEventTimelineEntries,
  eventTone,
  formatEventDetail,
  formatEventLabel,
} from "../lib/event-presentation.js";
import { countToolInvocations } from "../lib/tool-invocation-count.js";
import { buildConversationRoleCards } from "../lib/conversation-role-model.js";
import { createConversationRoleCards } from "./conversation-role-cards.js";
import { buildConversationSources } from "../lib/web-sources.js";
import { createConversationSources } from "./conversation-sources.js";
import {
  buildConversationToolActions,
  summarizeConversationTools,
} from "../lib/tool-activity-model.js";
import { isNonToolTimelineEvent } from "../lib/tool-timeline.js";

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
  const hasAuthoritativeCounts = taskProgress.hasSnapshot === true;
  const completed = hasAuthoritativeCounts
    ? countOf(taskProgress.completed)
    : Math.max(
        countOf(taskProgress.completed),
        items.filter((item) => item.status === "done").length,
      );
  const total = hasAuthoritativeCounts
    ? countOf(taskProgress.total)
    : Math.max(countOf(taskProgress.total), items.length);
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
      roleCards: [],
      sources: [],
      toolActions: [],
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
  const toolCount = countToolInvocations(scopedEvents);
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
    roleCards: buildConversationRoleCards({
      requestId: normalizedRequestId,
      events: scopedEvents,
      streaming,
    }),
    sources: buildConversationSources(scopedEvents),
    toolActions: buildConversationToolActions({
      requestId: normalizedRequestId,
      events: scopedEvents,
      streaming,
    }),
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
  const roleCards = createConversationRoleCards({ documentRoot });
  const sourceCards = createConversationSources({ documentRoot });
  const manuallyCollapsedStreamingRequests = new Set();
  const manuallyExpandedCompletedRequests = new Set();

  function createNode(input = {}) {
    const model = buildConversationActivityModel(input);
    if (!model.hasContent) return null;
    const hasFailures = model.failureCount > 0;

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
      hasFailures ? "Activity needs attention" : "Activity",
    );
    summary.appendChild(heading);
    const roleSummary = roleCards.createSummaryNode(model.roleCards);
    if (roleSummary) {
      details.classList.add("has-role-summary");
      summary.appendChild(roleSummary);
    }

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
    const toolSummary = summarizeConversationTools(model.toolActions);
    if (toolSummary) details.classList.add("has-tool-summary");
    if (toolSummary) facts.push(toolSummary);
    if (!toolSummary && model.toolCount > 0) {
      facts.push(`${model.toolCount} tool${model.toolCount === 1 ? "" : "s"}`);
    }
    const sourceCount = model.sources.reduce(
      (total, group) =>
        total + group.sources.length + (group.omittedSourceCount || 0),
      0,
    );
    if (sourceCount > 0)
      facts.push(`${sourceCount} source${sourceCount === 1 ? "" : "s"}`);
    const showEventCount =
      facts.length === 0 && !hasFailures && model.eventCount > 0;
    if (showEventCount) {
      facts.push(`${model.eventCount} events`);
    }
    const factsNode = appendTextNode(
      documentRoot,
      summary,
      "conversation-activity-facts",
      facts.join(" · "),
    );
    if (hasFailures) {
      factsNode.textContent += facts.length > 0 ? " · " : "";
      appendTextNode(
        documentRoot,
        factsNode,
        "failed",
        `${model.failureCount} failed`,
      );
    }
    details.appendChild(summary);

    const body = documentRoot.createElement("div");
    body.className = "conversation-activity-body";
    const hasRoleCards = model.roleCards.length > 0;
    const restoreCardsScroll = hasRoleCards
      ? roleCards.bindScroll({ requestId: model.requestId, body, details })
      : () => false;
    if (model.events.length > 0) {
      const timelineEvents = model.events.filter(isNonToolTimelineEvent);
      body.appendChild(
        roleCards.createNode({
          requestId: model.requestId,
          cards: model.roleCards,
          timeline: renderTimeline(documentRoot, timelineEvents),
          hasTimeline: timelineEvents.length > 0,
          onViewChange() {
            body.scrollTop = 0;
            schedulePinToLatest();
          },
        }),
      );
    }
    const sources = sourceCards.createNode(model.sources);
    if (sources) body.appendChild(sources);
    details.appendChild(body);

    const pinToLatest = () => {
      const showsTimeline =
        model.roleCards.length === 0 || roleCards.isTimeline(model.requestId);
      if (!showsTimeline) return restoreCardsScroll();
      return pinConversationActivityToLatest({
        details,
        body,
        streaming: model.openByDefault && showsTimeline,
      });
    };
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
    roleCards.forget(normalizedRequestId);
  }

  function reset() {
    manuallyCollapsedStreamingRequests.clear();
    manuallyExpandedCompletedRequests.clear();
    roleCards.reset();
  }

  return { createNode, forget, reset };
}
