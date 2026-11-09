/** One bounded poller for mounted metrics views; never refreshes the HOME/dashboard controller. */
export function createSystemMetricsController({ client, getEnvironmentId, render,
  setTimer = setTimeout, clearTimer = clearTimeout, pollMs = 2000, timeoutMs = 5000 }) {
  let active = false;
  let destroyed = false;
  let epoch = 0;
  let timer = null;
  let pending = null;

  function cancelTimer() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  function canReadMetrics() {
    if (destroyed || !active) return false;
    return typeof client.getSystemMetrics === "function";
  }
  function isCurrentRead(read) {
    if (!canReadMetrics() || read.epoch !== epoch) return false;
    return read.environmentId === getEnvironmentId();
  }
  function schedule() {
    cancelTimer();
    if (canReadMetrics()) timer = setTimer(() => { timer = null; void refresh(); }, pollMs);
  }
  async function refresh() {
    if (!canReadMetrics() || pending) return;
    cancelTimer();
    const read = { epoch, environmentId: getEnvironmentId(), abort: new AbortController(), timeout: null };
    pending = read;
    read.timeout = setTimer(() => read.abort.abort(), timeoutMs);
    try {
      const response = await client.getSystemMetrics(read.environmentId, { signal: read.abort.signal });
      if (!isCurrentRead(read) || read.abort.signal.aborted) return;
      render({ metrics: response.metrics, status: "live" });
    } catch {
      if (isCurrentRead(read)) render({ metrics: null, status: "unavailable" });
    } finally {
      clearTimer(read.timeout);
      pending = null;
      schedule();
    }
  }
  function invalidate() {
    epoch += 1; cancelTimer();
    if (pending) { clearTimer(pending.timeout); pending.abort.abort(); }
  }
  return {
    refresh,
    setActive(value) {
      if (destroyed || active === value) return;
      active = value;
      if (!active) { invalidate(); return; }
      render({ metrics: null, status: "connecting" });
      void refresh();
    },
    environmentChanged() {
      invalidate(); render({ metrics: null, status: "connecting" });
      if (active) void refresh();
    },
    destroy() { destroyed = true; active = false; invalidate(); },
  };
}
