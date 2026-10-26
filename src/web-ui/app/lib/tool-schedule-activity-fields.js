const ACTION_TITLES = Object.freeze({
  list: "List schedules",
  get: "Read schedule",
  create: "Create schedule",
  update: "Update schedule",
  pause: "Pause schedule",
  resume: "Resume schedule",
  cancel: "Cancel schedule",
  run_now: "Request schedule run",
});

const SCHEDULE_KINDS = Object.freeze({
  timer: "Timer",
  once: "Once",
  interval: "Interval",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
});

const TOOL_ACCESS_LABELS = Object.freeze({
  full_access: "FULL",
  full_plus: "FULL+",
});

function boundedScheduleText(meta, key, limit) {
  if (typeof meta[key] !== "string") return "";
  const text = meta[key].trim();
  if (!text) return "";
  if (text.length > limit || meta[`${key}Truncated`] === true)
    return `${text.slice(0, limit - 1)}…`;
  return text;
}

function hasKnownScheduleValue(meta, key, values) {
  if (meta[`${key}Truncated`] === true) return false;
  if (typeof meta[key] !== "string") return false;
  return Object.hasOwn(values, meta[key]);
}

/** Decode only schedules' declared input metadata; never infer from task or result text. */
export function scheduleActivityFields(meta, tool) {
  if (tool !== "schedules") return null;
  if (!hasKnownScheduleValue(meta, "scheduleAction", ACTION_TITLES))
    return { activityTitle: "", target: "", sent: [] };
  const activityTitle = ACTION_TITLES[meta.scheduleAction];
  const jobId = boundedScheduleText(meta, "scheduleJobId", 200);
  const title = boundedScheduleText(meta, "scheduleTitle", 200);
  const sent = [{ label: "Action", value: activityTitle }];
  if (jobId) sent.push({ label: "Schedule ID", value: jobId });
  if (title) sent.push({ label: "Title", value: title });
  if (hasKnownScheduleValue(meta, "scheduleKind", SCHEDULE_KINDS))
    sent.push({ label: "Schedule type", value: SCHEDULE_KINDS[meta.scheduleKind] });
  if (hasKnownScheduleValue(meta, "scheduleToolPermissionMode", TOOL_ACCESS_LABELS))
    sent.push({ label: "Schedule tool access", value: TOOL_ACCESS_LABELS[meta.scheduleToolPermissionMode] });
  return { activityTitle, target: title || jobId, sent };
}
