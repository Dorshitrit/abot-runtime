import { textOf } from "./text-format.js";

export function buildEventTimelineEntries(events) {
  const entries = [];
  for (const event of events) {
    const name = textOf(event.name || event.rawType || event.type);
    if (!name) continue;
    const summary = textOf(event.summary);
    const previous = entries[entries.length - 1];
    if (
      previous &&
      previous.name === name &&
      previous.summary === summary &&
      previous.tone === event.tone
    ) {
      previous.count = (previous.count || 1) + (event.count || 1);
      continue;
    }
    entries.push({
      ...event,
      name,
      summary,
      count: event.count || 1,
    });
  }
  return entries;
}

export function titleCaseEventValue(value) {
  const normalized = textOf(value)
    .replaceAll(/[_\.-]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  return normalized
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

export function formatToolName(rawTool) {
  const value = textOf(rawTool).trim();
  if (!value) return "";
  const known = {
    write_file: "file writer",
    read_file: "file reader",
    read_files: "file reader",
    text_editor: "text editor",
    exec: "terminal",
    web_search: "web search",
    web_fetch: "web fetch",
    memory_search: "memory search",
    memory_get: "memory lookup",
  };
  return known[value] || titleCaseEventValue(value);
}

export function getRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

export function getNumber(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function getPlanPayload(message) {
  const plan = getRecord(message.plan);
  if (!plan) return null;
  const rawItems = Array.isArray(plan.items) ? plan.items : [];
  const items = rawItems.flatMap((item) => {
    const record = getRecord(item);
    const title = textOf(record?.title).trim();
    if (!title) return [];
    return [
      {
        id: textOf(record.id),
        title,
        status: textOf(record.status, "pending"),
        order: getNumber(record.order, 0),
      },
    ];
  });
  return {
    summary: textOf(plan.summary),
    total: getNumber(plan.total, items.length),
    completed: getNumber(
      plan.completed,
      items.filter((item) => item.status === "done").length,
    ),
    items,
  };
}

export function getPlanItemPayload(message) {
  const item = getRecord(message.item);
  const title = textOf(item?.title).trim();
  if (!title) return null;
  return {
    id: textOf(item.id),
    title,
    status: textOf(item.status, "pending"),
    order: getNumber(item.order, 0),
  };
}

export function formatEventLabel(message) {
  const name = textOf(message.name || message.rawType || message.type);
  const status = textOf(message.status);
  const phase = textOf(message.phase);

  if (getPlanPayload(message) || getPlanItemPayload(message)) {
    return name || "Development progress";
  }
  if (
    name === "request_started" ||
    name === "request.started" ||
    name === "planning.started"
  ) {
    return "Preparing response";
  }
  if (name === "request_progress") {
    if (phase === "awaiting_tokens") return "Preparing response";
    if (phase === "awaiting_more_output") return "Answering";
    if (status === "failed") return "Response failed";
    return "Working";
  }
  if (
    name === "thinking.started" ||
    name === "thinking.delta" ||
    name === "planning.retry" ||
    name === "planning.failed"
  ) {
    return "Thinking";
  }
  if (name === "answer.started" || name === "token") return "Answering";
  if (name === "request.completed" || message.type === "completed") {
    return "Response ready";
  }
  if (name === "request.failed" || message.type === "failed") {
    return "Response failed";
  }
  if (name === "runtime.state") {
    return status || textOf(message.output) || "Runtime state";
  }
  if (name === "tool.intent") return "Next action";
  if (name.startsWith("tool.")) {
    const toolName = formatToolName(message.tool);
    if (status) return status;
    if (name === "tool.completed") {
      return toolName ? `${toolName} completed` : "Tool completed";
    }
    if (name === "tool.failed") {
      return toolName ? `${toolName} failed` : "Tool failed";
    }
    return toolName ? `Using ${toolName}` : "Using a tool";
  }
  return titleCaseEventValue(name) || "Event";
}

export function formatEventDetail(message) {
  const parts = [];
  const name = textOf(message.name || message.rawType || message.type);
  const plan = getPlanPayload(message);
  if (plan?.summary) parts.push(plan.summary);
  const item = getPlanItemPayload(message);
  if (item) {
    parts.push(
      item.order > 0
        ? `item ${item.order}${plan?.total ? `/${plan.total}` : ""}`
        : "plan item",
    );
  }
  const intent = textOf(message.intent || getRecord(message.meta)?.intent);
  if (name === "tool.approval.required") {
    return intent || "Review this action before it runs.";
  }
  if (intent) parts.push(intent);
  if (message.tool) parts.push(formatToolName(message.tool));
  if (message.message) parts.push(textOf(message.message));
  if (message.output && message.name !== "runtime.state") {
    parts.push(textOf(message.output).slice(0, 120));
  }
  if (message.error) parts.push(`error=${message.error}`);
  if (message.reason) parts.push(textOf(message.reason));
  return parts.join(" | ");
}

export function eventTone(message) {
  const name = textOf(message.name || message.type);
  const normalized = name.toLowerCase();
  if (
    message.ok === false ||
    textOf(message.status).toLowerCase() === "failed" ||
    normalized.includes("failed") ||
    normalized.includes("rejected") ||
    normalized.includes("response failed") ||
    message.type === "failed"
  ) {
    return "failed";
  }
  if (
    normalized.includes("completed") ||
    normalized.includes("complete") ||
    normalized.includes("approved") ||
    normalized.includes("response ready") ||
    message.type === "completed"
  ) {
    return "done";
  }
  if (name === "thinking.delta") return "thinking";
  return "active";
}

export function isLowValueActivityEvent(message) {
  const name = textOf(message.name || message.rawType || message.type);
  const type = textOf(message.type);
  if (type === "failed" || name === "request.failed") return false;
  return (
    name === "request_started" ||
    name === "request.started" ||
    name === "request_progress" ||
    name === "planning.started" ||
    name === "thinking.started" ||
    name === "thinking.delta" ||
    name === "thinking.completed" ||
    name === "context.window.snapshot" ||
    name === "context.window.provider_usage" ||
    name === "answer.started" ||
    name === "token" ||
    name === "request.completed" ||
    type === "completed"
  );
}

export function eventKeyFor(message, label, tone) {
  const name = textOf(message.name || message.rawType || message.type);
  const requestId = textOf(message.requestId);
  const tool = textOf(message.tool);
  const approvalId = textOf(message.approvalId);
  const status = textOf(message.status);
  const phase = textOf(message.phase);
  return [requestId, name, label, tone, tool, approvalId, status, phase]
    .filter(Boolean)
    .join("|");
}
