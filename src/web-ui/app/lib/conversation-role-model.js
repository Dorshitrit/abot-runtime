import {
  eventTone,
  formatEventDetail,
  formatEventLabel,
  titleCaseEventValue,
} from "./event-presentation.js";
import { textOf } from "./text-format.js";
import { countToolInvocations } from "./tool-invocation-count.js";

const ROLE_TITLES = Object.freeze({
  supervisor: "Supervisor",
  planner: "Planner",
  worker: "Worker",
  reviewer: "Reviewer",
});

const ROLE_RESPONSIBILITIES = Object.freeze({
  supervisor: "Coordinates the request",
  planner: "Plans the work",
  worker: "Performs assigned tasks",
  reviewer: "Reviews the result",
});

function latestRoleAction(group) {
  const toolEvent = group.toolEvents.at(-1);
  return roleActivitySummary(toolEvent || group.latestEvent);
}

function belongsToRoleRequest(event, requestId) {
  if (!event || typeof event !== "object") return false;
  return textOf(event.requestId) === requestId;
}

function activityPosition(event) {
  if (Number.isSafeInteger(event.eventSequence) && event.eventSequence > 0) {
    return { domain: "runtime", value: event.eventSequence };
  }
  const replaySequence = event.lastSeqNo ?? event.seqNo;
  if (Number.isSafeInteger(replaySequence) && replaySequence > 0) {
    return { domain: "replay", value: replaySequence };
  }
  return null;
}

function orderedRequestActivity(events, requestId) {
  const unique = [];
  const seen = new Set();
  const domains = new Map();
  for (const event of events) {
    if (!belongsToRoleRequest(event, requestId)) continue;
    const position = activityPosition(event);
    if (!position) {
      unique.push({ event, position });
      continue;
    }
    const identity = `${position.domain}:${position.value}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    unique.push({ event, position });
    const domain = domains.get(position.domain) || { events: [], next: 0 };
    domain.events.push({ event, position });
    domains.set(position.domain, domain);
  }
  for (const domain of domains.values()) {
    domain.events.sort(
      (left, right) => left.position.value - right.position.value,
    );
  }
  // Runtime and replay cursors are separate counters. Sort only within each
  // counter's existing slots, retaining arrival order for unsequenced history.
  return unique.map(({ event, position }) => {
    if (!position) return event;
    const domain = domains.get(position.domain);
    return domain.events[domain.next++].event;
  });
}

function activityEventName(event) {
  return textOf(event.eventName || event.name || event.rawType || event.type);
}

function isRequestTerminalEvent(event) {
  if (event.type === "completed" || event.type === "failed") return true;
  const name = activityEventName(event);
  return name === "request.completed" || name === "request.failed";
}

function isToolActivityEvent(event) {
  return activityEventName(event).startsWith("tool.");
}

function hasSupportedRoleStage(stage) {
  return Object.hasOwn(ROLE_TITLES, stage);
}

function isFailedRoleActivity(event) {
  return (textOf(event.tone) || eventTone(event)) === "failed";
}

function roleActivitySummary(event) {
  return (
    textOf(event.summary).trim() ||
    formatEventDetail(event) ||
    formatEventLabel(event)
  );
}

function createRoleGroup(role, event) {
  return { role, phase: "", latestEvent: event, toolEvents: [] };
}

function isActiveRoleActivity(group, activeRole, streaming) {
  if (!streaming) return false;
  if (group.role !== activeRole) return false;
  return !isFailedRoleActivity(group.latestEvent);
}

function canShowActiveRoles(streaming, terminalSeen) {
  if (terminalSeen) return false;
  return streaming;
}

function buildRoleCard(group, activeRole, streaming) {
  const failed = isFailedRoleActivity(group.latestEvent);
  const active = isActiveRoleActivity(group, activeRole, streaming);
  const toolCount = countToolInvocations(group.toolEvents);
  let tone = "recorded";
  if (active) tone = "active";
  if (failed) tone = "failed";
  return {
    id: group.role,
    role: group.role,
    title: ROLE_TITLES[group.role],
    responsibility: ROLE_RESPONSIBILITIES[group.role],
    phaseLabel: titleCaseEventValue(group.phase),
    summary: latestRoleAction(group),
    facts:
      toolCount > 0
        ? [`${toolCount} tool call${toolCount === 1 ? "" : "s"}`]
        : [],
    active,
    tone,
  };
}

export function buildConversationRoleCards({
  requestId,
  events = [],
  streaming = false,
} = {}) {
  const normalizedRequestId = textOf(requestId).trim();
  if (!normalizedRequestId) return [];

  const groups = new Map();
  let activeRole = "";
  let terminalSeen = false;
  const activityEvents = Array.isArray(events) ? events : [];
  for (const event of orderedRequestActivity(
    activityEvents,
    normalizedRequestId,
  )) {
    if (isRequestTerminalEvent(event)) {
      terminalSeen = true;
      activeRole = "";
      continue;
    }

    const stage = textOf(event.stage).trim();
    if (stage) {
      activeRole = "";
      if (!hasSupportedRoleStage(stage)) continue;
      activeRole = stage;
      const group = groups.get(stage) || createRoleGroup(stage, event);
      group.phase = textOf(event.phase);
      group.latestEvent = event;
      groups.set(stage, group);
    }

    if (!activeRole) continue;
    if (!isToolActivityEvent(event)) continue;
    const group = groups.get(activeRole);
    group.latestEvent = event;
    group.toolEvents.push({ ...event, eventName: activityEventName(event) });
  }

  return [...groups.values()].map((group) =>
    buildRoleCard(
      group,
      activeRole,
      canShowActiveRoles(streaming, terminalSeen),
    ),
  );
}
