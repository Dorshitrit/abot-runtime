import { textOf } from "./text-format.js";

function delegatedProgressPattern(event) {
  if (event.stage === "planner" && event.phase === "planning")
    return /^planning the delegated work(?:\.{3}|…)?$/i;
  if (event.stage === "worker" && event.phase === "working")
    return /^working on the delegated task(?:\.{3}|…)?$/i;
  if (event.stage === "reviewer" && event.phase === "reviewing")
    return /^auditing the recorded results(?:\.{3}|…)?$/i;
  if (event.stage === "supervisor" && event.phase === "resuming")
    return /^processing the delegated result(?:\.{3}|…)?$/i;
  return null;
}

function hasDelegatedProgressFailure(event) {
  if (event.tone === "failed") return true;
  if (event.ok === false) return true;
  if (event.error) return true;
  return textOf(event.status).toLowerCase() === "failed";
}

/** Hide redundant presentation text, retaining the recorded role handoff itself. */
export function isGenericDelegatedProgressEvent(event) {
  if (event?.type !== "event") return false;
  if (hasDelegatedProgressFailure(event)) return false;
  if (event.toolActivity) return false;
  if (textOf(event.reason).trim()) return false;
  if (textOf(event.intent).trim()) return false;
  const pattern = delegatedProgressPattern(event);
  if (!pattern) return false;
  const name = textOf(event.eventName || event.rawType || event.name).trim();
  if (name !== "runtime.state" && !pattern.test(name)) return false;
  const labels = [event.message, event.status, event.output, event.summary]
    .map((value) => textOf(value).trim()).filter(Boolean);
  if (labels.length === 0) return pattern.test(name);
  return labels.every((label) => pattern.test(label));
}
