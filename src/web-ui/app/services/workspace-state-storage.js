/** The in-memory view is a projection; only the server acknowledges persistence. */
export function createWorkspaceStateStorage({ fetchImpl = fetch, onError = () => {} } = {}) {
  let snapshot = null;
  const lanes = new Map();
  const failures = new Map();
  const pending = [];
  const listeners = new Set();

  async function request(input) {
    let response;
    let result;
    try {
      response = await fetchImpl("/web-ui-state", input ? {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
      } : { cache: "no-store" });
      result = await response.json();
    } catch (error) { throw uncertainMutationError(error, input); }
    if (!response.ok) throw workspaceResponseFailure(response, result, input);
    if (result.state?.version !== 1 || !Number.isSafeInteger(result.state.revision) ||
        !result.state.preferences || typeof result.state.queue !== "string")
      throw uncertainMutationError(new Error("The server returned invalid workspace state."), input);
    if (!snapshot || result.state.revision >= snapshot.revision) snapshot = result.state;
    return result.result;
  }
  function laneFor(input) {
    if (input.kind === "preference") return `preference:${input.key}`;
    if (input.kind === "queue") return `queue:${JSON.stringify([input.scope.environmentId, input.scope.sessionId])}`;
    return input.kind;
  }
  function report(error, lane) {
    failures.set(lane, error);
    onError(error);
  }
  function execute(input, completed = () => {}) {
    const lane = laneFor(input);
    const result = (lanes.get(lane) || Promise.resolve()).then(async () => {
      if (failures.has(lane)) throw failures.get(lane);
      const previousPreferences = JSON.stringify(snapshot?.preferences);
      const value = await request(input);
      try {
        completed();
        if (JSON.stringify(snapshot.preferences) !== previousPreferences)
          for (const listener of listeners) listener();
      } catch (error) { throw uncertainMutationError(error, input); }
      return value;
    });
    // Ordering/failure belongs to this preference or queue scope. The acknowledged
    // server snapshot remains shared; an unrelated failure is never permission to retry.
    lanes.set(lane, result.then(() => undefined, (error) => report(error, lane)));
    return result;
  }
  function getItem(key) {
    const queued = pending.findLast((entry) => entry.key === key);
    if (queued) return queued.value;
    return snapshot?.preferences[key] ?? null;
  }
  function write(key, value) {
    if (!snapshot) throw new Error("Workspace settings have not loaded.");
    if (failures.has(`preference:${key}`)) {
      const rejected = Promise.reject(failures.get(`preference:${key}`));
      void rejected.catch(() => {});
      return rejected;
    }
    const before = getItem(key);
    if (before === value) return Promise.resolve();
    const entry = { key, before, value };
    pending.push(entry);
    const discardPending = () => {
      const index = pending.indexOf(entry);
      if (index >= 0) pending.splice(index, 1);
    };
    const result = execute({ kind: "preference", ...entry }, discardPending);
    void result.catch(() => {
      discardPending();
      for (const listener of listeners) listener();
    });
    return result;
  }
  return {
    getItem,
    setItem: (key, value) => write(key, String(value)),
    removeItem: (key) => write(key, null),
    execute,
    async flush() {
      await Promise.all(lanes.values());
      if (failures.size) throw failures.values().next().value;
    },
    async refresh() {
      try {
        const previous = snapshot?.revision;
        await request();
        if (snapshot.revision !== previous) for (const listener of listeners) listener();
      } catch (error) { report(error, "refresh"); throw error; }
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    snapshot: () => snapshot,
    error: () => failures.values().next().value ?? null,
  };
}

function uncertainMutationError(error, input) {
  if (!input) return error;
  const failure = error instanceof Error ? error : new Error(String(error));
  // An absent acknowledgement cannot prove a POST had no durable effect.
  failure.workspaceMutationMayHaveCommitted = true;
  return failure;
}

function workspaceResponseFailure(response, result, input) {
  const error = new Error(result.message || "Workspace state is unavailable.");
  error.status = response.status;
  error.code = result.error;
  if (response.status < 500) return error;
  // A server failure may follow durable publication, such as lock cleanup failure.
  return uncertainMutationError(error, input);
}
