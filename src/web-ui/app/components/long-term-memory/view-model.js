export function createMemoryManagerView(snapshot) {
  const editorRecord = snapshot.editor?.recordId
    ? snapshot.items.find((record) => record.id === snapshot.editor.recordId) ||
      null
    : null;
  const canWrite = snapshot.enabled === true && snapshot.available === true;
  return Object.freeze({
    ...snapshot,
    editorRecord,
    canWrite,
    busy: snapshot.loading || Boolean(snapshot.mutation),
    status: memoryStatus(snapshot),
    emptyMessage: snapshot.query
      ? "No memories match this search."
      : "No long-term memories have been stored yet.",
    pageLabel: pageLabel(snapshot),
    hasPreviousPage: snapshot.offset > 0,
    hasNextPage: snapshot.offset + snapshot.items.length < snapshot.total,
  });
}

export function parseMemoryTags(value) {
  return String(value ?? "")
    .split(/[\n,]/u)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function formatMemoryTimestamp(value) {
  const timestamp = Date.parse(String(value ?? ""));
  if (!Number.isFinite(timestamp)) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

export function memoryOriginLabel(origin) {
  const labels = {
    passive_response: "Learned from conversation",
    web_ui: "Added in Web UI",
    management_api: "Added through API",
  };
  return labels[origin] || "Stored memory";
}

export function buildMemoryDeleteConfirmation(record) {
  return `Delete this memory?\n\n${record.content}`;
}

function memoryStatus(snapshot) {
  if (snapshot.enabled === null) {
    return Object.freeze({ tone: "unavailable", label: "Unavailable" });
  }
  if (!snapshot.enabled) {
    return Object.freeze({ tone: "disabled", label: "Disabled" });
  }
  if (!snapshot.available) {
    return Object.freeze({ tone: "unavailable", label: "Unavailable" });
  }
  return Object.freeze({ tone: "enabled", label: "Enabled" });
}

function pageLabel(snapshot) {
  if (snapshot.total === 0) return "0 memories";
  const start = snapshot.offset + 1;
  const end = Math.min(snapshot.total, snapshot.offset + snapshot.items.length);
  return `${start}–${end} of ${snapshot.total}`;
}
