const STATUS_LABELS = Object.freeze({
  ready: "Ready", queued: "Queued", indexing: "Indexing", stale: "Source changed",
  missing: "Source missing", failed: "Index failed", unsupported: "Unsupported format",
  unavailable: "Unavailable",
});
export function basketStatusLabel(status) { return STATUS_LABELS[status] || "Unavailable"; }
export function isBasketSourceWorking(source) { return ["queued", "indexing"].includes(source.status); }
export function basketStatusGroup(source) {
  if (source.status === "ready") return "ready";
  if (isBasketSourceWorking(source)) return "indexing";
  return "attention";
}
export function filterBasketSources(items, query, filter) {
  const needle = String(query || "").trim().toLocaleLowerCase();
  return items.filter((item) => {
    if (filter !== "all" && basketStatusGroup(item) !== filter) return false;
    if (!needle) return true;
    return [item.displayName, item.path].some((value) => String(value || "").toLocaleLowerCase().includes(needle));
  });
}
export function basketIndexedTime(value) {
  if (!value) return "Not indexed";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Not indexed";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
export function basketSize(value) {
  if (!Number.isFinite(value)) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
