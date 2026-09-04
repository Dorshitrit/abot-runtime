import {
  getPlanItemPayload,
  getPlanPayload,
  getRecord,
} from "./event-presentation.js";
import { textOf } from "./text-format.js";

const PLAN_ITEM_STATUSES = new Set([
  "pending",
  "in_progress",
  "done",
  "blocked",
]);

export function taskStatusClass(status) {
  const normalized = textOf(status).trim().toLowerCase();
  if (normalized === "done" || normalized === "completed") return "done";
  if (normalized === "in_progress" || normalized === "active") return "active";
  if (normalized === "blocked" || normalized === "failed") return "failed";
  if (normalized === "superseded") return "muted";
  return "pending";
}

function isTaskProgressCount(value) {
  return Number.isInteger(value) && value >= 0;
}

function hasValidPlanItem(item) {
  if (!getRecord(item)) return false;
  if (typeof item.title !== "string" || !item.title.trim()) return false;
  return PLAN_ITEM_STATUSES.has(item.status);
}

function hasValidPlanSnapshot(plan) {
  if (!Array.isArray(plan.items)) return false;
  if (!plan.items.every(hasValidPlanItem)) return false;
  if (plan.total !== undefined && !isTaskProgressCount(plan.total))
    return false;
  if (plan.completed !== undefined && !isTaskProgressCount(plan.completed)) {
    return false;
  }
  const total = plan.total ?? plan.items.length;
  if (total < plan.items.length) return false;
  return (plan.completed ?? 0) <= total;
}

function isPlanEventForRequest(current, message) {
  if (message.type !== "event") return false;
  if (typeof message.requestId !== "string" || !message.requestId.trim()) {
    return false;
  }
  if (current && current.requestId !== message.requestId) return false;
  if (message.stage === "development_plan") return true;
  return textOf(message.name).startsWith("planner.plan.");
}

function planEventPosition(message) {
  if (isTaskProgressCount(message.eventSequence)) {
    return { source: "eventSequence", value: message.eventSequence };
  }
  if (isTaskProgressCount(message.seqNo)) {
    return { source: "seqNo", value: message.seqNo };
  }
  return undefined;
}

function comparePlanEventPositions(left, right) {
  if (!left || !right) return undefined;
  if (left.source !== right.source) return undefined;
  return left.value - right.value;
}

function isCoveredPlanEvent(position, baseline) {
  const comparison = comparePlanEventPositions(position, baseline);
  return comparison !== undefined && comparison <= 0;
}

function isLaterPlanEvent(position, baseline) {
  const comparison = comparePlanEventPositions(position, baseline);
  return comparison !== undefined && comparison > 0;
}

function planEventSequence(current, message) {
  if (isTaskProgressCount(message.eventSequence)) {
    return {
      lastEventSequence: Math.max(
        current?.lastEventSequence ?? 0,
        message.eventSequence,
      ),
      lastSeqNo: current?.lastSeqNo,
    };
  }
  return {
    lastEventSequence: current?.lastEventSequence,
    lastSeqNo: isTaskProgressCount(message.seqNo)
      ? Math.max(current?.lastSeqNo ?? 0, message.seqNo)
      : current?.lastSeqNo,
  };
}

function orderPlanItems(items) {
  return [...items].sort((left, right) => {
    const leftOrder = left.order > 0 ? left.order : Infinity;
    const rightOrder = right.order > 0 ? right.order : Infinity;
    return leftOrder - rightOrder;
  });
}

function findPlanItemIndex(items, nextItem) {
  const nextId = nextItem.id.trim();
  if (nextId) {
    const idIndex = items.findIndex((item) => item.id.trim() === nextId);
    if (idIndex >= 0) return idIndex;
  }
  const nextTitle = nextItem.title.trim().toLowerCase();
  return items.findIndex((item) => {
    if (nextId && item.id.trim()) return false;
    return item.title.trim().toLowerCase() === nextTitle;
  });
}

function projectPlanItemUpdate(current, message) {
  if (!hasValidPlanItem(message.item)) return null;
  const item = getPlanItemPayload(message);
  const items = [...(current?.items || [])];
  const index = findPlanItemIndex(items, item);
  const previousItem = items[index];
  const nextItem = {
    ...item,
    id: item.id || previousItem?.id || "",
    order: item.order || previousItem?.order || 0,
  };
  if (index < 0) items.push(nextItem);
  else items[index] = nextItem;

  const total = isTaskProgressCount(message.planTotal)
    ? message.planTotal
    : Math.max(current?.total || 0, items.length);
  const statusChange =
    Number(nextItem.status === "done") -
    Number(previousItem?.status === "done");
  const completed = isTaskProgressCount(message.planCompleted)
    ? message.planCompleted
    : Math.max(0, (current?.completed || 0) + statusChange);
  return {
    summary: textOf(message.planSummary, current?.summary || ""),
    total,
    completed,
    items,
    hasSnapshot: current?.hasSnapshot || false,
  };
}

function normalizedPlanItemUpdate(message, position) {
  return {
    item: getPlanItemPayload(message),
    position,
    ...(typeof message.planSummary === "string"
      ? { planSummary: message.planSummary }
      : {}),
    ...(isTaskProgressCount(message.planTotal)
      ? { planTotal: message.planTotal }
      : {}),
    ...(isTaskProgressCount(message.planCompleted)
      ? { planCompleted: message.planCompleted }
      : {}),
  };
}

function orderPlanItemUpdates(updates) {
  return [...updates].sort(
    (left, right) =>
      comparePlanEventPositions(left.position, right.position) ?? 0,
  );
}

function hasRetainedPlanEvent(updates, position) {
  return updates.some(
    (update) => comparePlanEventPositions(update.position, position) === 0,
  );
}

function reducePlanReplayState(current, message, rawPlan) {
  const replay = current?.replayState || { itemUpdates: [] };
  const position = planEventPosition(message);
  if (isCoveredPlanEvent(position, replay.snapshotPosition)) return null;
  if (rawPlan) {
    return {
      snapshot: { ...getPlanPayload(message), hasSnapshot: true },
      snapshotPosition: position,
      itemUpdates: replay.itemUpdates.filter((update) =>
        isLaterPlanEvent(update.position, position),
      ),
    };
  }
  if (!hasValidPlanItem(message.item)) return null;
  if (hasRetainedPlanEvent(replay.itemUpdates, position)) return null;
  const update = normalizedPlanItemUpdate(message, position);
  // Intermediate item states matter when legacy deltas omit plan counters.
  // Keep normalized deltas only until an authoritative snapshot covers them.
  return {
    ...replay,
    itemUpdates: orderPlanItemUpdates([...replay.itemUpdates, update]),
  };
}

function projectPlanReplayState(replay) {
  let projection = replay.snapshot;
  for (const update of replay.itemUpdates) {
    projection = projectPlanItemUpdate(projection, update);
  }
  return projection;
}

export function reduceTaskProgress(current, message) {
  if (!isPlanEventForRequest(current, message)) return current;
  const rawPlan = getRecord(message.plan);
  if (rawPlan && !hasValidPlanSnapshot(rawPlan)) return current;
  const replayState = reducePlanReplayState(current, message, rawPlan);
  if (!replayState) return current;
  const projection = projectPlanReplayState(replayState);
  const items = orderPlanItems(projection.items);
  return {
    ...projection,
    requestId: message.requestId,
    items,
    activeItem:
      items.find((item) => item.status === "in_progress")?.title || "",
    hasSignal: true,
    ...planEventSequence(current, message),
    replayState,
  };
}
