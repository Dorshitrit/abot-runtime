const ACTION_TITLES = Object.freeze({
  list_information_sources: "List information sources",
  search_information_sources: "Search information sources",
  read_information_source: "Read information source",
});
const SEARCH_STATUSES = Object.freeze({ found: "Found", empty: "No matches", unavailable: "Unavailable" });

function boundedDisplayText(value, maximum) {
  if (typeof value !== "string") return "";
  const clean = value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim();
  const points = Array.from(clean);
  return points.length > maximum ? `${points.slice(0, maximum - 1).join("")}…` : clean;
}
function documentName(value) { return boundedDisplayText(value, 120); }

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function addCount(fields, label, value) {
  if (value !== undefined) fields.push({ label, value: String(value) });
}
function sourceNames(meta, maximum) {
  return Array.from({ length: 5 }, (_, index) => documentName(meta[`documentName${index + 1}`]))
    .filter(Boolean).slice(0, maximum ?? 5);
}

/** Basket activity accepts display metadata only; source bodies and generic previews are never projected. */
export function basketActivityFields(meta, tool, completed, ok) {
  if (tool !== "information_basket") return null;
  const action = typeof meta.basketAction === "string" ? meta.basketAction : "";
  const known = Object.hasOwn(ACTION_TITLES, action);
  const activityTitle = known ? ACTION_TITLES[action] : "Information Basket";
  const sent = known ? [{ label: "Action", value: activityTitle }] : [];
  const received = [];
  const read = action === "read_information_source";
  const name = read && known ? documentName(meta.documentName) : "";
  const returned = completed && ok === true && known ? count(meta.itemCount) : undefined;
  const names = completed && ok === true && known
    ? (read ? (name ? [name] : []) : sourceNames(meta, returned)) : [];
  if (completed && known) {
    if (action === "search_information_sources" && Object.hasOwn(SEARCH_STATUSES, meta.basketSearchStatus))
      received.push({ label: "Search status", value: SEARCH_STATUSES[meta.basketSearchStatus] });
    addCount(received, read ? "Sources read" : action === "search_information_sources" ? "Matching sources" : "Listed sources", returned);
    if (names.length) received.push({ label: names.length === 1 ? "Document" : "Documents", value: names.join(", ") });
    if (returned !== undefined && returned > names.length)
      addCount(received, "Returned sources without displayed names", returned - names.length);
    if (ok === true && !read) addCount(received, "Further sources", count(meta.omittedDocumentCount));
  }
  const error = typeof meta.errorCode === "string" && /^basket_[a-z0-9_]{1,160}$/.test(meta.errorCode)
    ? meta.errorCode : "";
  return {
    activityTitle,
    target: read ? name : (returned === undefined ? "" : `${returned} ${returned === 1 ? "source" : "sources"}`),
    sent, received, error,
    outcome: completed && ok === true && !read && known &&
      (meta.basketSearchStatus === "empty" || (meta.basketSearchStatus !== "unavailable" && returned === 0)) ? "empty" : "completed",
  };
}

/** Shared by live and replay timeline summaries, with no raw output or model-intent fallback. */
export function basketActivitySummary(message) {
  if (message.tool !== "information_basket") return undefined;
  const meta = message.meta && typeof message.meta === "object" && !Array.isArray(message.meta) ? message.meta : {};
  const name = message.eventName || message.name || message.rawType || message.type;
  const activity = basketActivityFields(meta, message.tool, name === "tool.completed", message.ok);
  return [activity.target, ...activity.received.map(field => `${field.label}: ${field.value}`), activity.error]
    .filter(Boolean).join(" | ");
}

const BASKET_STATUS_PHASES = new Set([
  "discovery_found", "search_started", "search_completed", "read_started", "read_completed",
  "search_unavailable", "read_unavailable",
]);

/** Runtime enrichment turns status messages into event names; preserve filename punctuation and casing. */
export function basketStatusLabel(message) {
  if (message.stage !== "information_basket" || !BASKET_STATUS_PHASES.has(message.phase)) return undefined;
  const name = message.eventName || message.name || message.rawType || message.type;
  const label = name === "runtime.state" ? message.message || message.status : message.name;
  return boundedDisplayText(label, 800) || "Information Basket";
}
