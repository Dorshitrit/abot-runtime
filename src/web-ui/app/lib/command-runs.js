const runsByState = new WeakMap();
export function isCommandRequest(request) {
  return (
    request.events?.some(
      (event) => (event.payload || event).requestKind === "command",
    ) === true
  );
}
function runs(state) {
  if (!runsByState.has(state)) runsByState.set(state, new Map());
  return runsByState.get(state);
}
function key(scope, requestId) {
  return JSON.stringify([scope.environmentId, scope.sessionId, requestId]);
}

export function rememberCommandRun(state, scope, requestId) {
  const records = runs(state);
  const identity = key(scope, requestId);
  if (records.get(identity)?.terminal) return false;
  if (!records.has(identity))
    records.set(identity, {
      ...scope,
      requestId,
      status: "running",
      terminal: false,
    });
  return true;
}

export function hasActiveCommandRun(state, scope) {
  return runs(state).get(key(scope, state.activeRequestId))?.terminal === false;
}

export function recordCommandEvent(state, message, environmentId) {
  if (message.requestKind !== "command") return null;
  const terminal = message.type === "completed" || message.type === "failed";
  const started =
    message.type === "event" && message.name === "command.started";
  if (!terminal && !started) return null;
  const records = runs(state);
  const scope = {
    environmentId:
      message.environment || message.environmentId || environmentId,
    sessionId: message.sessionId,
  };
  const identity = key(scope, message.requestId);
  if (started && records.get(identity)?.terminal) return null;
  const record = {
    ...scope,
    requestId: message.requestId,
    createdAt: records.get(identity)?.createdAt ?? new Date(message.timestamp ?? Date.now()).getTime(),
    message,
    terminal,
    status: terminal ? message.type : "running",
  };
  records.set(identity, record);
  trimSettledCommandRuns(records);
  return record;
}

function trimSettledCommandRuns(records) {
  if (records.size <= 200) return;
  const settled = [...records].find(([, record]) => record.terminal);
  if (settled) records.delete(settled[0]);
}

export function latestCommandRun(state, scope) {
  return [...runs(state).values()]
    .filter(
      (record) =>
        record.environmentId === scope.environmentId &&
        record.sessionId === scope.sessionId,
    )
    .at(-1);
}

export function commandRunSummary(record) {
  const name = record.message?.command?.name || "command";
  if (record.status === "failed") return `/${name} failed.`;
  if (record.status === "running")
    return name === "compact"
      ? "Compacting conversation history…"
      : `/${name} is running…`;
  if (record.message?.outcome === "no_change")
    return "No saved history is eligible for compaction.";
  return name === "compact"
    ? "Conversation history compacted."
    : `/${name} completed.`;
}
