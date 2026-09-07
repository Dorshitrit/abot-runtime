import { scheduleTimeLabel } from "./schedule-message.js";
export { scheduleErrorMessage } from "./schedule-errors.js";

export const SCHEDULE_WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export function scheduleDurationLabel(milliseconds) {
  const minutes = milliseconds / 60000;
  if (minutes % 1440 === 0) return `${minutes / 1440} days`;
  if (minutes % 60 === 0) return `${minutes / 60} hours`;
  return `${minutes} minutes`;
}

export function scheduleDescription(job) {
  const schedule = job.schedule;
  if (!schedule) return "Schedule unavailable";
  if (schedule.kind === "timer")
    return `After ${scheduleDurationLabel(schedule.delayMs)}`;
  if (schedule.kind === "once")
    return scheduleTimeLabel(schedule.at, job.timeZone);
  if (schedule.kind === "interval")
    return `Every ${scheduleDurationLabel(schedule.everyMs)}`;
  if (schedule.kind === "daily") return `Daily at ${schedule.at}`;
  if (schedule.kind === "weekly")
    return `${schedule.weekdays.map((day) => SCHEDULE_WEEKDAYS[day]).join(", ")} at ${schedule.at}`;
  if (schedule.kind === "monthly")
    return `Day ${schedule.dayOfMonth} each month at ${schedule.at}`;
  return "Schedule unavailable";
}

function matchesScheduleState(job, state) {
  if (!state || state === "all") return true;
  if (state === "current") return ["active", "paused"].includes(job.state);
  return job.state === state;
}

export function matchesScheduleFilter(job, query, state, sessions = []) {
  if (!matchesScheduleState(job, state)) return false;
  const needle = String(query || "")
    .trim()
    .toLocaleLowerCase();
  if (!needle) return true;
  const session = sessions.find((item) => item.id === job.sessionId);
  return [
    job.title,
    job.prompt,
    job.sessionId,
    session?.title,
    job.modelProfileId,
    scheduleDescription(job),
  ].some((value) =>
    String(value || "")
      .toLocaleLowerCase()
      .includes(needle),
  );
}

export function canManageSchedule(job) {
  if (!job) return false;
  return job.state !== "cancelled";
}

export function canRunScheduleNow(job) {
  if (!job) return false;
  return job.state !== "cancelled";
}

export function emptyScheduleListMessage(snapshot) {
  if (snapshot.loading) return "Loading…";
  if (snapshot.error)
    return "The schedule list is unavailable. Refresh to load it again.";
  if (snapshot.jobs.length) return "No schedules match your search.";
  return "No schedules yet. Create one here or ask ABot in a conversation.";
}
