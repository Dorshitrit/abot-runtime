import { titleCaseEventValue } from "./event-presentation.js";
import { projectToolActivityEvent } from "./tool-activity-event.js";

const TITLES = Object.freeze({
  dev_view: "Read",
  read_file: "Read file",
  write_file: "Write file",
  edit_file: "Edit file",
  local_search: "Search files",
  document_reader: "Read document",
  inspect_project: "Inspect project",
  inspect_json: "Inspect JSON",
  inspect_code_outline: "Outline code",
  memory_search: "Search memory",
  memory_get: "Read memory",
  memory_add: "Save memory",
  memory_delete: "Delete memory",
  web_search: "Search the web",
  web_fetch: "Read web page",
});

const PHASES = Object.freeze({
  "tool.payload.started": [1, "preparing", "Preparing"],
  "tool.payload.completed": [2, "preparing", "Ready"],
  "tool.approval.required": [3, "awaiting_approval", "Awaiting approval"],
  "tool.approval.granted": [4, "preparing", "Approved"],
  "tool.started": [5, "running", "Running"],
  "tool.payload.failed": [6, "failed", "Preparation failed"],
  "tool.approval.rejected": [6, "failed", "Not approved"],
  "tool.failed": [6, "failed", "Failed"],
  "tool.completed": [6, "completed", "Completed"],
});

const SETTLED_LABELS = Object.freeze({
  completed: "Completed",
  empty: "No results",
  unchanged: "No change",
  failed: "Failed",
  incomplete: "Outcome not recorded",
});

function isSettledToolEvent(event) {
  return PHASES[event.name]?.[0] === 6;
}

function mergeFields(previous, incoming) {
  const fields = new Map(previous.map((field) => [field.label, field]));
  for (const field of incoming) fields.set(field.label, field);
  return [...fields.values()];
}

function initialAction(id, evidence, count) {
  return {
    id,
    tool: evidence.tool,
    executorRole: evidence.executorRole || "",
    roleCallId: evidence.roleCallId || "",
    title: TITLES[evidence.tool] || titleCaseEventValue(evidence.tool),
    target: "",
    status: "preparing",
    statusLabel: "Preparing",
    intent: "",
    sent: [],
    received: [],
    preview: "",
    previewTruncated: false,
    partial: false,
    executed: false,
    legacy: !evidence.executionId,
    count,
  };
}

function completionStatus(evidence) {
  if (evidence.ok === false) return "failed";
  if (evidence.ok !== true) return "incomplete";
  return evidence.outcome;
}

function applyPhase(action, evidence) {
  const [, status, label] = PHASES[evidence.name];
  action.status = status;
  action.statusLabel = label;
  if (evidence.name !== "tool.completed") return;
  action.status = completionStatus(evidence);
  action.statusLabel = SETTLED_LABELS[action.status];
  if (evidence.tool === "memory_delete" && action.status === "empty") {
    action.statusLabel = "No matching record";
  }
  if (evidence.tool === "dev_view" && action.status === "empty") {
    action.statusLabel = "No match in scanned range";
  }
}

function applyEvidence(action, evidence) {
  if (evidence.executorRole) action.executorRole = evidence.executorRole;
  if (evidence.roleCallId) action.roleCallId = evidence.roleCallId;
  if (isExecutedToolEvent(evidence)) action.executed = true;
  if (evidence.target) action.target = evidence.target;
  if (evidence.intent) action.intent = evidence.intent;
  action.sent =
    evidence.name === "tool.completed"
      ? mergeFields(evidence.sent, action.sent)
      : mergeFields(action.sent, evidence.sent);
  action.received = mergeFields(action.received, evidence.received);
  if (evidence.error) {
    action.received = mergeFields(action.received, [
      { label: "Error", value: evidence.error },
    ]);
  }
  if (evidence.preview) action.preview = evidence.preview;
  if (evidence.name === "tool.completed")
    action.previewTruncated = evidence.previewTruncated;
  if (evidence.name === "tool.completed") action.partial = evidence.partial;
}

function isExecutedToolEvent(evidence) {
  const { name, beforeExternalExecution } = evidence;
  if (name === "tool.failed" && beforeExternalExecution) return false;
  return (
    name === "tool.started" ||
    name === "tool.completed" ||
    name === "tool.failed"
  );
}

function eventSequence(event) {
  if (Number.isSafeInteger(event.eventSequence) && event.eventSequence > 0)
    return event.eventSequence;
  return null;
}

function orderGroupEvents(entries) {
  const sequenced = entries
    .filter((entry) => entry.sequence !== null)
    .sort((a, b) => a.sequence - b.sequence);
  let next = 0;
  return entries.map((entry) =>
    entry.sequence === null ? entry : sequenced[next++],
  );
}

function canAdvanceToolPhase(phase, evidence, nextRank) {
  if (nextRank > 2) return nextRank >= phase.rank;
  if (phase.rank > 2) return false;
  if (!phase.payloadStage) return nextRank >= phase.rank;
  if (!evidence.payloadStage) return nextRank >= phase.rank;
  if (evidence.payloadStageCount !== phase.payloadStageCount) return false;
  if (evidence.payloadStage !== phase.payloadStage) {
    return evidence.payloadStage > phase.payloadStage;
  }
  return nextRank >= phase.rank;
}

function finishAction(group, streaming) {
  const action = initialAction(
    group.id,
    group.entries[0].evidence,
    group.count,
  );
  const phase = { rank: 0, payloadStage: 0, payloadStageCount: 0 };
  for (const { evidence } of orderGroupEvents(group.entries)) {
    applyEvidence(action, evidence);
    const nextRank = PHASES[evidence.name][0];
    if (!canAdvanceToolPhase(phase, evidence, nextRank)) continue;
    phase.rank = nextRank;
    if (evidence.payloadStage) {
      phase.payloadStage = evidence.payloadStage;
      phase.payloadStageCount = evidence.payloadStageCount;
    }
    applyPhase(action, evidence);
  }
  if (!streaming && phase.rank < 6) {
    action.status = "incomplete";
    action.statusLabel = "Completion not recorded";
  }
  return action;
}

/** Lifecycle correlation is exact. Older, uncorrelated history supplies outcome rows only. */
export function buildConversationToolActions({
  requestId,
  events = [],
  streaming = false,
}) {
  const groups = new Map();
  const seen = new Set();
  for (const [index, event] of events.entries()) {
    if (event.requestId !== requestId) continue;
    const evidence = event.toolActivity || projectToolActivityEvent(event);
    if (!evidence) continue;
    const sequence = eventSequence(event);
    if (sequence !== null && seen.has(sequence)) continue;
    if (sequence !== null) seen.add(sequence);
    if (!evidence.executionId && !isSettledToolEvent(evidence)) continue;
    const id = evidence.executionId
      ? JSON.stringify([requestId, evidence.executionId])
      : JSON.stringify([
          requestId,
          "recorded",
          sequence ?? event.lastSeqNo ?? event.seqNo ?? index,
        ]);
    const count = evidence.executionId
      ? 1
      : Math.max(1, Number(event.count) || 1);
    const group = groups.get(id) || { id, count, entries: [] };
    group.entries.push({ evidence, sequence });
    groups.set(id, group);
  }
  return [...groups.values()].map((group) => finishAction(group, streaming));
}

const CATEGORIES = Object.freeze({
  dev_view: "read",
  read_file: "read",
  document_reader: "read",
  inspect_project: "project inspection",
  inspect_json: "JSON inspection",
  inspect_code_outline: "code outline",
  write_file: "write",
  edit_file: "edit",
  local_search: "file search",
  memory_search: "memory search",
  memory_get: "memory lookup",
  memory_add: "memory save",
  memory_delete: "memory deletion",
  web_search: "web search",
  web_fetch: "web read",
});

export function summarizeConversationTools(actions) {
  const counts = new Map();
  for (const action of actions) {
    const category = CATEGORIES[action.tool] || "tool action";
    counts.set(category, (counts.get(category) || 0) + action.count);
  }
  const categories = [...counts];
  const summary = categories
    .slice(0, 3)
    .map(
      ([category, count]) =>
        `${count} ${category}${count === 1 ? "" : pluralSuffix(category)}`,
    )
    .join(" · ");
  const remaining = categories
    .slice(3)
    .reduce((total, [, count]) => total + count, 0);
  return remaining
    ? `${summary} · ${remaining} other action${remaining === 1 ? "" : "s"}`
    : summary;
}

function pluralSuffix(category) {
  return category.endsWith("search") ? "es" : "s";
}
