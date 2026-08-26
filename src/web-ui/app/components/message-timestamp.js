function timestampDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const normalized =
    typeof value === "string" && /^\d+$/u.test(value.trim())
      ? Number(value)
      : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function buildMessageTimestamp(value, { locales, timeZone } = {}) {
  const date = timestampDate(value);
  if (!date) return null;
  const zoneOptions = timeZone ? { timeZone } : {};
  return {
    dateTime: date.toISOString(),
    label: new Intl.DateTimeFormat(locales, {
      dateStyle: "short",
      timeStyle: "short",
      ...zoneOptions,
    }).format(date),
    title: new Intl.DateTimeFormat(locales, {
      dateStyle: "full",
      timeStyle: "long",
      ...zoneOptions,
    }).format(date),
  };
}

export function createMessageTimestamp({
  documentRoot,
  value,
  locales,
  timeZone,
}) {
  const presentation = buildMessageTimestamp(value, { locales, timeZone });
  if (!presentation) return null;
  const time = documentRoot.createElement("time");
  time.className = "message-timestamp";
  time.dateTime = presentation.dateTime;
  time.title = presentation.title;
  time.textContent = presentation.label;
  return time;
}
