import { eventTone, formatEventDetail, formatEventLabel, isLowValueActivityEvent } from "./event-presentation.js";
import { buildConversationToolActions } from "./tool-activity-model.js";
import { projectToolActivityEvent } from "./tool-activity-event.js";
import { correlateToolApprovalActivity } from "./tool-approval-activity.js";
import { isNonToolTimelineEvent } from "./tool-timeline.js";
import { buildMemoryActivities, isMemoryRetrievalEvent } from "./memory-activity-model.js";
import { projectBasketActivityEvent } from "./basket-activity-model.js";
import { projectRoleDelegationEvent } from "./role-delegation-event.js";
import { projectRoleReturnEvent } from "./role-return-event.js";
import { isUserInteractionMessage } from "./user-interaction-event.js";
import { textOf } from "./text-format.js";

const RECORDED_ROLES = new Set(["supervisor", "planner", "worker", "researcher", "reviewer"]);
const CONTEXT_MANAGEMENT_EVENTS = new Set([
  "context.compaction.started", "context.compaction.completed", "context.compaction.failed",
]);

function eventName(event) {
  return textOf(event?.eventName || event?.name || event?.rawType || event?.type);
}

export function isAcknowledgementPresentationEvent(event) {
  if (eventName(event) !== "thinking.delta") return false;
  return event.presentationKind === "acknowledgement";
}

function hasEventPosition(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function eventPosition(event) {
  if (hasEventPosition(event.eventSequence))
    return { domain: "runtime", value: event.eventSequence };
  const replay = event.lastSeqNo ?? event.seqNo;
  if (hasEventPosition(replay)) return { domain: "replay", value: replay };
  return null;
}

/** Legacy domains and unsequenced positions are never compared with another counter. */
function orderedEvidence(records) {
  const domains = new Map();
  for (const record of records) {
    const position = eventPosition(record.event);
    if (!position) continue;
    const domain = domains.get(position.domain) || { records: [], next: 0 };
    domain.records.push({ record, value: position.value });
    domains.set(position.domain, domain);
  }
  for (const domain of domains.values()) domain.records.sort((a, b) => a.value - b.value);
  return records.map((record) => {
    const position = eventPosition(record.event);
    if (!position) return record;
    const domain = domains.get(position.domain);
    return domain.records[domain.next++].record;
  });
}

function evidenceIdentity(event, index) {
  const position = eventPosition(event);
  if (position) return JSON.stringify([event.requestId, event.generation || "", position.domain, position.value]);
  return JSON.stringify([event.requestId, "unsequenced", index]);
}

function scopedEvidence(requestId, events, updates) {
  const records = [];
  const seen = new Set();
  for (const [index, event] of events.entries()) {
    if (event?.requestId !== requestId) continue;
    const id = evidenceIdentity(event, index);
    if (seen.has(id)) continue;
    seen.add(id);
    records.push({ id, event, update: false });
  }
  for (const update of updates) {
    if (!isUserInteractionMessage(update)) continue;
    if (update.requestId !== requestId) continue;
    const id = textOf(update.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    records.push({ id, event: update, update: true });
  }
  return orderedEvidence(records);
}

function recordedRole(event, evidence) {
  if (evidence?.executorRole)
    return RECORDED_ROLES.has(evidence.executorRole) ? evidence.executorRole : "unknown";
  if (RECORDED_ROLES.has(event.stage)) return event.stage;
  return "unknown";
}

function recordedExecutionOwners(records) {
  const owners = new Map();
  for (const { event, update } of records) {
    if (update) continue;
    const evidence = event.toolActivity || projectToolActivityEvent(event);
    if (!evidence?.executionId || !evidence.executorRole) continue;
    owners.set(evidence.executionId, recordedRole(event, evidence));
  }
  return owners;
}

function nextLegacyRole(event, previous) {
  if (event.type === "completed" || event.type === "failed") return "";
  if (["request.completed", "request.failed"].includes(eventName(event))) return "";
  if (projectRoleDelegationEvent(event) || projectRoleReturnEvent(event)) return previous;
  if (projectBasketActivityEvent(event)) return previous;
  if (!event.stage) return previous;
  return RECORDED_ROLES.has(event.stage) ? event.stage : "";
}

function toolOwner(evidence, owners, legacyRole) {
  if (owners.has(evidence.executionId)) return owners.get(evidence.executionId);
  if (evidence.executorRole) return RECORDED_ROLES.has(evidence.executorRole) ? evidence.executorRole : "unknown";
  if (evidence.executionId) return "unknown";
  return legacyRole || "unknown";
}

/** Match existing role projection: recorded modern owners, stage association only for legacy evidence. */
function bindTimelineToolOwners(records) {
  const owners = recordedExecutionOwners(records);
  let legacyRole = "";
  return records.map((record) => {
    if (record.update) return record;
    const evidence = record.event.toolActivity || projectToolActivityEvent(record.event);
    if (!evidence) {
      legacyRole = nextLegacyRole(record.event, legacyRole);
      return record;
    }
    return { ...record, event: { ...record.event, toolActivity: {
      ...evidence, executorRole: toolOwner(evidence, owners, legacyRole),
    } } };
  });
}

function appendUnpairedToolDiagnostic(entries, record) {
  if (!isNonToolTimelineEvent(record.event)) return;
  entries.push({ id: record.id, kind: "event", role: recordedRole(record.event, record.event.toolActivity), event: record.event });
}

function actionIdentity(requestId, event, evidence, index) {
  if (evidence.executionId) return JSON.stringify([requestId, evidence.executionId]);
  const sequence = event.eventSequence ?? event.lastSeqNo ?? event.seqNo ?? index;
  return JSON.stringify([requestId, "recorded", sequence]);
}

function isSupervisorSkillEvent(event) {
  if (event.stage !== "supervisor") return false;
  if (event.phase !== "skills") return false;
  return !eventName(event).startsWith("tool.");
}

function isTimelineDiagnosticEvent(event) {
  if (["thinking.delta", "token", "context.compaction.progress"].includes(eventName(event))) return false;
  return !isLowValueActivityEvent(event);
}

function appendToolEntries(entries, toolSeen, intentSeen, action, evidence, record) {
  if (!action) return appendUnpairedToolDiagnostic(entries, record);
  const { event } = record;
  const role = recordedRole(event, action);
  const identity = { role, ...(action.roleCallId ? { callId: action.roleCallId } : {}) };
  if (evidence.intent && !intentSeen.has(action.id)) {
    entries.push({ ...identity, id: action.id + ":intent", kind: "message", source: "intent", text: evidence.intent });
    intentSeen.add(action.id);
  }
  if (toolSeen.has(action.id)) return;
  entries.push({ ...identity, id: action.id, kind: "tool", action });
  toolSeen.add(action.id);
}

function isRepeatedSemanticEntry(entry, seen) {
  const semanticId = entry.delegation?.id || entry.receipt?.id;
  if (!semanticId) return false;
  const identity = entry.kind + ":" + semanticId;
  if (seen.has(identity)) return true;
  seen.add(identity);
  return false;
}

function isContextManagementDiagnostic(event) {
  if (event.type !== "event") return false;
  return CONTEXT_MANAGEMENT_EVENTS.has(eventName(event));
}

function isCanonicalPlanDiagnostic(event) {
  if (event.type !== "event") return false;
  if (event.stage === "development_plan") return true;
  return eventName(event).startsWith("planner.plan.");
}

function hasRecordedPlannerRole({ event, update }) {
  if (update) return false;
  if (event.toolActivity || eventName(event).startsWith("tool.")) return false;
  if (event.stage === "planner") return true;
  if (projectRoleDelegationEvent(event)?.childRole === "planner") return true;
  return projectRoleReturnEvent(event)?.childRole === "planner";
}

function planDiagnosticRole(records) {
  if (records.some(hasRecordedPlannerRole)) return "planner";
  return "root";
}

function projectNonToolEntry(record, memoryActivities, memorySeen, planRole) {
  const { id, event } = record;
  const base = { id, role: recordedRole(event) };
  if (isAcknowledgementPresentationEvent(event))
    return { ...base, kind: "message", role: "supervisor", source: "acknowledgement", text: textOf(event.text || event.delta) };
  const delegation = projectRoleDelegationEvent(event);
  if (delegation) return { ...base, kind: "delegation", role: delegation.callerRole, delegation };
  const receipt = projectRoleReturnEvent(event);
  if (receipt) return { ...base, kind: "return", role: receipt.childRole, receipt };
  if (isMemoryRetrievalEvent(event)) {
    if (memorySeen) return null;
    return { ...base, kind: "memory", role: "root", activities: memoryActivities };
  }
  const basket = projectBasketActivityEvent(event);
  if (basket) return { ...base, kind: "basket", role: "root", activities: [basket] };
  if (isSupervisorSkillEvent(event)) {
    const summary = textOf(event.summary) || formatEventDetail(event) || formatEventLabel(event);
    return { ...base, kind: "skill", role: "supervisor", activities: [{ summary, tone: textOf(event.tone) || eventTone(event) }] };
  }
  if (!isTimelineDiagnosticEvent(event)) return null;
  if (isContextManagementDiagnostic(event)) return { ...base, kind: "event", role: "context", event };
  const role = isCanonicalPlanDiagnostic(event) ? planRole : base.role;
  return { ...base, kind: "event", role, event };
}

/** Pure UI projection: recorded chronology, existing tool outcomes, no execution decisions. */
export function buildConversationWorkTimeline({ requestId, events = [], updates = [], streaming = false } = {}) {
  if (!requestId) return [];
  const correlated = correlateToolApprovalActivity(events, requestId);
  const records = bindTimelineToolOwners(scopedEvidence(requestId, correlated, updates));
  const orderedEvents = records.filter((record) => !record.update).map((record) => record.event);
  const actions = new Map(buildConversationToolActions({ requestId, events: orderedEvents, streaming })
    .map((action) => [action.id, action]));
  const memoryActivities = buildMemoryActivities({ requestId, events: orderedEvents, streaming });
  const planRole = planDiagnosticRole(records);
  const entries = [];
  const toolSeen = new Set();
  const intentSeen = new Set();
  const semanticSeen = new Set();
  let memorySeen = false;
  let eventIndex = 0;
  for (const record of records) {
    const { id, event } = record;
    if (record.update) {
      entries.push({ id, kind: "message", role: "root", source: "interaction", text: event.text,
        ...(event.interactionOrigin ? { origin: event.interactionOrigin } : {}) });
      continue;
    }
    const index = eventIndex++;
    const evidence = event.toolActivity || projectToolActivityEvent(event);
    if (evidence) {
      const actionId = actionIdentity(requestId, event, evidence, index);
      const action = actions.get(actionId);
      appendToolEntries(entries, toolSeen, intentSeen, action, evidence, record);
      continue;
    }
    const entry = projectNonToolEntry(record, memoryActivities, memorySeen, planRole);
    if (!entry) continue;
    if (entry.kind === "memory") memorySeen = true;
    if (isRepeatedSemanticEntry(entry, semanticSeen)) continue;
    entries.push(entry);
  }
  return entries;
}
