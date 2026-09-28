export function createEventRefresh({
  canRefresh,
  refresh,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let timer;
  let generation = { pending: null, queued: false };

  function clearScheduled() {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  }

  function cancel() {
    clearScheduled();
    generation.queued = false;
    generation = { pending: null, queued: false };
  }

  function hasQueuedRefresh(current) {
    if (current !== generation) return false;
    if (!current.queued) return false;
    return canRefresh();
  }

  async function drain(current) {
    do {
      current.queued = false;
      await refresh();
    } while (hasQueuedRefresh(current));
  }

  function run() {
    clearScheduled();
    if (!canRefresh()) {
      cancel();
      return Promise.resolve();
    }
    const current = generation;
    if (current.pending) {
      current.queued = true;
      return current.pending;
    }
    let resolve;
    let reject;
    const pending = new Promise((done, failed) => {
      resolve = done;
      reject = failed;
    });
    current.pending = pending;
    function failed(error) {
      current.pending = null;
      reject(error);
    }
    function finished() {
      if (hasQueuedRefresh(current)) {
        void drain(current).then(finished, failed);
        return;
      }
      current.pending = null;
      resolve();
    }
    void drain(current).then(finished, failed);
    return pending;
  }

  function schedule() {
    if (!canRefresh()) {
      cancel();
      return;
    }
    if (generation.pending) {
      generation.queued = true;
      return;
    }
    clearScheduled();
    timer = setTimer(() => {
      timer = undefined;
      void run();
    }, 80);
  }

  return { run, schedule, cancel };
}
