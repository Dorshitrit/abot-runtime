function isToolInvocationStart(event) {
  return event.eventName === "tool.started";
}

function hasFiniteInvocationMultiplicity(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function toolInvocationMultiplicity(event) {
  if (!hasFiniteInvocationMultiplicity(event.count)) return 1;
  return Math.max(1, event.count);
}

export function countToolInvocations(events) {
  let count = 0;
  for (const event of events) {
    if (!isToolInvocationStart(event)) continue;
    count += toolInvocationMultiplicity(event);
  }
  return count;
}
