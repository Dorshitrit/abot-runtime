const SCHEDULE_ERRORS = {
  scheduler_store_in_use:
    "Schedules are being managed by another ABot process. This window cannot access them right now.",
  scheduler_unavailable: "The scheduling service is not available right now.",
  scheduler_stopped:
    "The scheduling service has stopped. Reconnect after ABot starts again.",
  scheduler_job_not_found:
    "This schedule is no longer available. Refresh the list to see current schedules.",
  scheduler_job_cancelled:
    "This schedule has been cancelled and cannot run again.",
  scheduler_session_deleted: "The conversation for this schedule was deleted.",
  scheduler_session_not_found:
    "The conversation for this schedule is no longer available.",
  scheduler_model_required: "Choose a model for this schedule.",
  scheduler_model_unavailable:
    "The saved model is unavailable. Choose another configured model.",
  scheduler_schedule_in_past: "Choose a date and time in the future.",
};

export function scheduleErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  const [code, ...details] = message.split(":");
  if (SCHEDULE_ERRORS[code]) return SCHEDULE_ERRORS[code];
  if (details.length && code.startsWith("scheduler_"))
    return details.join(":").trim();
  if (/^[a-z][a-z0-9]*_[a-z0-9_]+$/.test(message))
    return "This schedule request could not be completed. Refresh and try again.";
  return message || "Schedules could not be loaded. Refresh and try again.";
}
