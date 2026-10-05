import {
  compareContextEvidence,
  canReplaceContextWindowEvidence,
} from "./context-window-snapshot-order.js";
import { selectCompactionPercentages } from "./context-window-measurement.js";

function terminalFingerprint(event) {
  const fields = [
    "name",
    "modelStep",
    "profileId",
    "provider",
    "model",
    "activationId",
    "modelInvocationScope",
    "compactionScope",
    "scopeId",
    "sourceRevision",
    "coveredSourceCount",
    "beforeInputTokens",
    "afterInputTokens",
    "contextWindowTokens",
    "beforeUsedContextPercent",
    "afterUsedContextPercent",
    "issueCode",
    "reason",
  ];
  return JSON.stringify(
    fields.map((key) => [key, typeof event[key], String(event[key])]),
  );
}

function hasConflictingCycleBinding(cycle, event) {
  for (const key of [
    "modelStep",
    "profileId",
    "provider",
    "model",
    "activationId",
    "modelInvocationScope",
  ]) {
    if (cycle[key] && event[key] && cycle[key] !== event[key]) return true;
  }
  return false;
}

function cycleIdentity(event) {
  const identity = {};
  for (const key of [
    "requestId",
    "generation",
    "invocationId",
    "modelStep",
    "profileId",
    "provider",
    "model",
    "activationId",
    "modelInvocationScope",
  ]) {
    identity[key] = event[key] || "";
  }
  return identity;
}

function canConfirmCompactionTerminal(event, requestTerminal) {
  if (!requestTerminal) return true;
  const difference = compareContextEvidence(event, requestTerminal);
  return difference === null || difference > 0;
}

export function reduceContextCompaction(cycles, event, requestTerminal = null) {
  const phase = event.name?.replace("context.compaction.", "");
  if (!["started", "completed", "failed"].includes(phase)) return cycles;
  if (typeof event.invocationId !== "string" || !event.invocationId.trim())
    return cycles;
  const previous = cycles.get(event.invocationId);
  if (previous && hasConflictingCycleBinding(previous, event)) {
    return new Map(cycles).set(event.invocationId, {
      ...previous,
      status: "conflicted",
    });
  }
  const cycle = previous || {
    ...cycleIdentity(event),
    status: "pending",
    started: null,
    terminals: [],
    interruptedAt: requestTerminal,
  };
  if (phase === "started") {
    if (cycle.started || cycle.terminals.length) return cycles;
    const next = {
      ...cycle,
      started: event,
      status: cycle.interruptedAt ? "interrupted" : "pending",
    };
    return new Map(cycles).set(event.invocationId, next);
  }
  const fingerprint = terminalFingerprint(event);
  if (cycle.terminals.some((receipt) => receipt.fingerprint === fingerprint))
    return cycles;
  const terminals = [...cycle.terminals, { event, fingerprint }];
  let status = phase;
  if (!canConfirmCompactionTerminal(event, cycle.interruptedAt))
    status = "interrupted";
  if (terminals.length > 1 || cycle.status === "conflicted")
    status = "conflicted";
  return new Map(cycles).set(event.invocationId, {
    ...cycle,
    status,
    terminals,
  });
}

export function interruptContextCompactions(cycles, terminal) {
  const next = new Map(cycles);
  for (const [id, cycle] of cycles) {
    if (cycle.status === "conflicted") continue;
    const receipt = cycle.terminals[0];
    const hasConfirmedTerminal =
      receipt && canConfirmCompactionTerminal(receipt.event, terminal);
    const status = hasConfirmedTerminal
      ? receipt.event.name.replace("context.compaction.", "")
      : "interrupted";
    next.set(id, { ...cycle, status, interruptedAt: terminal });
  }
  return next;
}

function preferLaterCycle(previous, incoming, eventOf) {
  if (!previous) return incoming;
  if (canReplaceContextWindowEvidence(eventOf(previous), eventOf(incoming)))
    return incoming;
  return previous;
}

export function projectContextCompactions(cycles) {
  let pendingCompaction = null;
  let lastCompaction = null;
  let lastCompactionEvent = null;
  let openCompactionCount = 0;
  for (const cycle of cycles.values()) {
    if (cycle.status === "pending") {
      openCompactionCount += 1;
      pendingCompaction = preferLaterCycle(
        pendingCompaction,
        cycle,
        (value) => value.started,
      );
    }
    for (const receipt of cycle.terminals) {
      if (canReplaceContextWindowEvidence(lastCompactionEvent, receipt.event))
        lastCompactionEvent = receipt.event;
    }
    if (cycle.status !== "completed") continue;
    const event = cycle.terminals[0].event;
    const percentages = selectCompactionPercentages(event);
    if (!percentages) continue;
    const candidate = { ...cycleIdentity(event), ...percentages, event };
    lastCompaction = preferLaterCycle(
      lastCompaction,
      candidate,
      (value) => value.event,
    );
  }
  return {
    pendingCompaction,
    lastCompaction,
    lastCompactionEvent,
    openCompactionCount,
  };
}
