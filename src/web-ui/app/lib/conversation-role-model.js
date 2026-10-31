import { recordedPresentationRole, rolePresentation } from "./role-presentation.js";
import {
  eventTone,
  formatEventDetail,
  formatEventLabel,
  titleCaseEventValue,
} from "./event-presentation.js";
import { textOf } from "./text-format.js";
import {
  isRoleDelegationEvent,
  projectRoleDelegationEvent,
} from "./role-delegation-event.js";
import {
  isRoleReturnEvent,
  projectRoleReturnEvent,
} from "./role-return-event.js";
import { countToolInvocations } from "./tool-invocation-count.js";
import { projectToolActivityEvent } from "./tool-activity-event.js";
import { correlateToolApprovalActivity } from "./tool-approval-activity.js";
import {
  hasSupervisorBasketActivity,
  isBasketDiscoveryEvent,
  isBasketStatusEvent,
  projectBasketActivityEvent,
} from "./basket-activity-model.js";
import {
  buildConversationToolActions,
  summarizeConversationTools,
} from "./tool-activity-model.js";

const ROLE_TITLES = Object.freeze({
  supervisor: "Supervisor",
  planner: "Planner",
  worker: "Worker",
  researcher: "Researcher",
  reviewer: "Reviewer",
  unknown: "Unattributed actions",
});

const ROLE_RESPONSIBILITIES = Object.freeze({
  supervisor: "Coordinates the request",
  planner: "Plans the work",
  worker: "Performs assigned tasks",
  researcher: "Investigates assigned questions",
  reviewer: "Reviews the result",
  unknown: "Executor not recorded",
});

function latestRoleAction(group) {
  if (group.summarySupersededByReturn) return "";
  if (!group.latestEvent) return "";
  if (group.toolActions.some((action) => !action.legacy)) {
    return group.latestRoleEvent && !isSupervisorSkillActivity(group.latestRoleEvent)
      ? roleActivitySummary(group.latestRoleEvent)
      : "";
  }
  const toolEvent = group.toolEvents.at(-1);
  const event = toolEvent || group.latestEvent;
  return isSupervisorSkillActivity(event) ? "" : roleActivitySummary(event);
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
    const delegation = projectRoleDelegationEvent(event);
    const receipt = projectRoleReturnEvent(event);
    if (!position && !delegation && !receipt) {
      unique.push({ event, position });
      continue;
    }
    let identity;
    if (receipt) identity = `return:${receipt.id}`;
    else if (delegation) identity = `delegation:${delegation.id}`;
    else identity = `${position.domain}:${position.value}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    unique.push({ event, position });
    if (!position) continue;
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

function isSupervisorSkillActivity(event) {
  return event.stage === "supervisor" && event.phase === "skills"
    && !isToolActivityEvent(event);
}

function roleActivityStage(event) {
  if (isToolActivityEvent(event)) return "";
  if (isRoleDelegationEvent(event) || isRoleReturnEvent(event)) return "";
  return textOf(event.stage).trim();
}

function hasSupportedRoleStage(stage) {
  return Object.hasOwn(ROLE_TITLES, stage);
}

function isFailedRoleActivity(event) {
  if (!event) return false;
  if (isToolActivityEvent(event)) return false;
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
  return {
    role,
    presentationRole: recordedPresentationRole(role, event?.presentationRole),
    phase: "",
    latestEvent: event,
    latestRoleEvent: null,
    toolEvents: [],
    toolActions: [],
    skillActivities: [],
    basketActivities: [],
    delegations: [],
    returns: [],
    summarySupersededByReturn: false,
  };
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
  const presentation = rolePresentation(group.role, group.presentationRole);
  const failed = isFailedRoleActivity(group.latestEvent);
  const active = isActiveRoleActivity(group, activeRole, streaming);
  const toolCount = countToolInvocations(group.toolEvents);
  const toolSummary = summarizeConversationTools(group.toolActions);
  const roleIdentityRecorded = group.latestRoleEvent || group.delegations[0];
  let tone = "recorded";
  if (active) tone = "active";
  if (failed) tone = "failed";
  return {
    id: group.role,
    role: group.role,
    title: presentation?.title ?? (
      group.role === "supervisor" && !roleIdentityRecorded
        ? "Root agent"
        : ROLE_TITLES[group.role]),
    responsibility: presentation?.responsibility ?? ROLE_RESPONSIBILITIES[group.role],
    phaseLabel: titleCaseEventValue(group.phase),
    summary: latestRoleAction(group),
    ...(group.skillActivities.length > 0
      ? { skillActivities: group.skillActivities }
      : {}),
    ...(group.basketActivities.length > 0
      ? { basketActivities: group.basketActivities }
      : {}),
    ...(group.delegations.length > 0 ? { delegations: group.delegations } : {}),
    ...(group.returns.length > 0 ? { returns: group.returns } : {}),
    toolActions: group.toolActions,
    facts: toolSummary
      ? [toolSummary]
      : toolCount > 0
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
  const orderedEvents = orderedRequestActivity(
    correlateToolApprovalActivity(activityEvents, normalizedRequestId),
    normalizedRequestId,
  );
  const supervisorBasketIdentified = hasSupervisorBasketActivity(orderedEvents);
  const executionOwners = recordedExecutionOwners(orderedEvents);
  const toolEvents = [];
  for (const event of orderedEvents) {
    if (isRequestTerminalEvent(event)) {
      toolEvents.push(event);
      terminalSeen = true;
      activeRole = "";
      continue;
    }

    const basketActivity = supervisorBasketIdentified || isBasketDiscoveryEvent(event)
      ? projectBasketActivityEvent(event)
      : null;
    if (basketActivity) {
      const group = groups.get("supervisor") || createRoleGroup("supervisor", null);
      group.basketActivities.push(basketActivity);
      groups.set("supervisor", group);
    }
    if (isBasketStatusEvent(event)) continue;

    const delegation = projectRoleDelegationEvent(event);
    if (delegation) {
      const group = groups.get("supervisor") || createRoleGroup("supervisor", null);
      group.delegations.push(delegation);
      groups.set("supervisor", group);
      continue;
    }

    const receipt = projectRoleReturnEvent(event);
    if (receipt) {
      const group = groups.get("planner") || createRoleGroup("planner", null);
      group.returns.push(receipt);
      group.summarySupersededByReturn = true;
      groups.set("planner", group);
      continue;
    }

    const stage = roleActivityStage(event);
    if (stage) {
      activeRole = "";
      if (hasSupportedRoleStage(stage)) {
        activeRole = stage;
        const group = groups.get(stage) || createRoleGroup(stage, event);
        group.phase = textOf(event.phase);
        group.latestEvent = event;
        group.latestRoleEvent = event;
        group.presentationRole = recordedPresentationRole(stage, event.presentationRole) || group.presentationRole;
        group.summarySupersededByReturn = false;
        if (isSupervisorSkillActivity(event)) {
          group.skillActivities.push({
            summary: roleActivitySummary(event),
            tone: textOf(event.tone) || eventTone(event),
          });
        }
        groups.set(stage, group);
      }
    }

    if (!isToolActivityEvent(event)) continue;
    const evidence = event.toolActivity || projectToolActivityEvent(event);
    const owner = toolExecutorRole(evidence, executionOwners, activeRole);
    if (evidence)
      toolEvents.push({
        ...event,
        toolActivity: { ...evidence, executorRole: owner },
      });
    if (!owner) continue;
    const group = groups.get(owner) || createRoleGroup(owner, event);
    group.latestEvent = event;
    group.toolEvents.push({ ...event, eventName: activityEventName(event) });
    groups.set(owner, group);
  }

  for (const action of buildConversationToolActions({
    requestId: normalizedRequestId,
    events: toolEvents,
    streaming,
  })) {
    const owner = action.executorRole || "unknown";
    const group = groups.get(owner) || createRoleGroup(owner, {});
    group.toolActions.push(action);
    group.presentationRole = recordedPresentationRole(owner, action.presentationRole) || group.presentationRole;
    groups.set(owner, group);
  }

  return [...groups.values()].map((group) =>
    buildRoleCard(
      group,
      activeRole,
      canShowActiveRoles(streaming, terminalSeen),
    ),
  );
}

function recordedExecutionOwners(events) {
  const owners = new Map();
  for (const event of events) {
    const evidence = event.toolActivity || projectToolActivityEvent(event);
    if (!evidence?.executionId || !evidence.executorRole) continue;
    const role = hasSupportedRoleStage(evidence.executorRole)
      ? evidence.executorRole
      : "unknown";
    owners.set(evidence.executionId, role);
  }
  return owners;
}

function toolExecutorRole(evidence, executionOwners, activeRole) {
  if (evidence?.executionId && executionOwners.has(evidence.executionId)) {
    return executionOwners.get(evidence.executionId);
  }
  if (evidence?.executorRole) {
    return hasSupportedRoleStage(evidence.executorRole)
      ? evidence.executorRole
      : "unknown";
  }
  if (evidence?.executionId) return "unknown";
  return activeRole;
}
