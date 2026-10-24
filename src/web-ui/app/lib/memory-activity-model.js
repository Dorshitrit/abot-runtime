import { textOf } from "./text-format.js";

const RETRIEVAL_STATES = Object.freeze({
  "memory.retrieval.started": "active",
  "memory.retrieval.completed": "done",
  "memory.retrieval.failed": "failed",
});

export function isMemoryRetrievalEvent(event) {
  return Object.hasOwn(RETRIEVAL_STATES, memoryEventName(event));
}

function memoryEventName(event) {
  return textOf(event?.eventName || event?.name || event?.rawType || event?.type);
}

function sequenceOf(event, field) {
  const value = field === "replay" ? event.lastSeqNo ?? event.seqNo : event.eventSequence;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function hasCompleteMemoryOrdering(events, field) {
  return events.every((event) => sequenceOf(event, field) !== null);
}

function orderedMemoryEvents(events) {
  for (const field of ["runtime", "replay"]) {
    if (!hasCompleteMemoryOrdering(events, field)) continue;
    const unique = new Map();
    for (const event of events) {
      const sequence = sequenceOf(event, field);
      if (!unique.has(sequence)) unique.set(sequence, event);
    }
    return [...unique.entries()].sort(([left], [right]) => left - right).map(([, event]) => event);
  }
  return events;
}

function memoryActivity(event, streaming) {
  const recordedState = RETRIEVAL_STATES[memoryEventName(event)];
  const state = recordedState === "active" && !streaming ? "incomplete" : recordedState;
  const labels = {
    active: "Checking memory…",
    done: "Memory checked",
    failed: "Memory retrieval failed",
    incomplete: "Memory check incomplete",
  };
  return {
    state,
    label: labels[state],
    detail: state === "failed" ? textOf(event.summary || event.reason || event.error) : "",
  };
}

/** Show the latest retrieval status for this request; recorded events stay intact. */
export function buildMemoryActivities({ requestId, events = [], streaming = false } = {}) {
  const scoped = events.filter((event) =>
    textOf(event?.requestId) === requestId && isMemoryRetrievalEvent(event));
  const latest = orderedMemoryEvents(scoped).at(-1);
  return latest ? [memoryActivity(latest, streaming)] : [];
}
