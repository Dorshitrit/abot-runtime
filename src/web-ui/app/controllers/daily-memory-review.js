import { localReviewDay } from "../services/home-guidance-preferences.js";

const reviewLimit = 10;
const recentLimit = 50;

function hasCoWorkerSource(record) {
  if (record.origin === "passive_observation") return true;
  return Array.isArray(record.observationSources) && record.observationSources.length > 0;
}

function isMemoryPageUnavailable(page) {
  return page.status?.enabled === false || page.status?.available === false;
}

function hasValidMemoryTotal(page) {
  return Number.isSafeInteger(page.total) && page.total >= 0;
}

/** Uses existing stored-memory APIs; Keep is a UI receipt, never a promotion. */
export function createDailyMemoryReview({ client, getEnvironmentId, preferences, render, now = () => new Date() }) {
  let revision = 0;
  let environment = "";
  let attemptedDay = "";
  let items = [];
  let index = 0;
  let busy = false;
  let error = "";
  let abort;
  let pendingLoad;
  let active = false;
  const snapshot = () => ({ items, index, busy, error, remaining: items.length - index });
  const publish = () => render(snapshot());
  const isCurrent = (operation, target) => operation === revision && target === getEnvironmentId();

  function reset() {
    revision += 1;
    abort?.abort();
    abort = null;
    pendingLoad = null;
    items = [];
    index = 0;
    busy = false;
    error = "";
    attemptedDay = "";
    active = false;
    publish();
  }

  async function load(manual = false) {
    const target = getEnvironmentId();
    const day = localReviewDay(now());
    if (!active) return false;
    if (!manual && attemptedDay === day) return false;
    attemptedDay = day;
    const operation = ++revision;
    abort = new AbortController();
    const input = { environmentId: target, origin: "passive_observation", signal: abort.signal };
    error = "";
    try {
      const first = await client.listLongTermMemories({ ...input, limit: 1 });
      if (!isCurrent(operation, target) || !active) return false;
      if (isMemoryPageUnavailable(first)) throw new Error("Memory unavailable");
      if (!hasValidMemoryTotal(first)) throw new Error("Invalid memory count");
      if (first.total === 0) {
        items = [];
        index = 0;
        publish();
        return true;
      }
      const recent = await client.listLongTermMemories({ ...input, limit: recentLimit, offset: Math.max(0, first.total - recentLimit) });
      if (!isCurrent(operation, target) || !active) return false;
      if (isMemoryPageUnavailable(recent)) throw new Error("Memory unavailable");
      items = (recent.items || []).filter(hasCoWorkerSource)
        .filter((record) => !preferences.hasReviewed(target, record))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, reviewLimit);
      index = 0;
      publish();
      return true;
    } catch {
      // An optional invitation must not interrupt Home or retry in a loop.
      if (!manual || !isCurrent(operation, target) || !active) return false;
      error = "Saved memories could not be loaded. Close this review and try again.";
      publish();
      return true;
    }
  }

  function requestReview(manual = false) {
    if (pendingLoad) return pendingLoad;
    const request = load(manual);
    pendingLoad = request;
    void request.finally(() => { if (pendingLoad === request) pendingLoad = null; });
    return request;
  }

  function markOffered() {
    if (!items.length || environment !== getEnvironmentId()) return false;
    const day = localReviewDay(now());
    if (preferences.wasOffered(environment, day)) return false;
    preferences.markOffered(environment, day);
    return true;
  }

  async function decide(action) {
    if (!active || busy || environment !== getEnvironmentId()) return false;
    const record = items[index];
    if (!record || !["keep", "delete"].includes(action)) return false;
    const target = environment;
    const operation = revision;
    error = "";
    if (action === "delete") {
      busy = true;
      publish();
      try {
        const result = await client.deleteLongTermMemory({ environmentId: target, id: record.id });
        if (!isCurrent(operation, target)) return false;
        if (result?.deleted !== true) throw new Error("Delete not confirmed");
      } catch {
        if (isCurrent(operation, target)) error = "This memory could not be deleted. Try again, or keep it for now.";
        return false;
      } finally {
        if (isCurrent(operation, target)) { busy = false; publish(); }
      }
    }
    if (!isCurrent(operation, target)) return false;
    preferences.markReviewed(target, record);
    index += 1;
    publish();
    return true;
  }

  return {
    snapshot, decide, markOffered, reset,
    async loadForReview() {
      const operation = revision;
      const target = environment;
      if (pendingLoad) await pendingLoad;
      if (!active || !isCurrent(operation, target)) return false;
      if (items.length > index) return true;
      return requestReview(true);
    },
    update(enabled, { automatic = true } = {}) {
      const target = getEnvironmentId();
      if (target !== environment) { reset(); environment = target; }
      if (!enabled) { if (active) reset(); return; }
      active = true;
      if (automatic) void requestReview();
    },
  };
}
