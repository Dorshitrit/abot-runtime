import { escapeHtml } from "../../lib/text-format.js";
import { SCHEDULE_WEEKDAYS } from "../../lib/schedule-presentation.js";
import { scheduleErrorMessage } from "../../lib/schedule-errors.js";

function deviceDateTime(instant) {
  if (!instant) return "";
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function options(items, selected) {
  return items
    .map(
      ({ value, label }) =>
        `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`,
    )
    .join("");
}

function scheduleFields(job = {}) {
  const schedule = job.schedule || { kind: "once" };
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const seconds = formatDurationSeconds(
    schedule.everyMs ?? schedule.delayMs ?? 3600000,
  );
  return `
    <label>Repeat<select name="kind">${options(
      [
        { value: "once", label: "Once" },
        { value: "timer", label: "After a delay" },
        { value: "interval", label: "At a fixed interval" },
        { value: "daily", label: "Every day" },
        { value: "weekly", label: "Selected weekdays" },
        { value: "monthly", label: "Every month" },
      ],
      schedule.kind,
    )}</select></label>
    <label data-schedule-kind="once">Date and time (${escapeHtml(zone)})<input name="onceAt" type="datetime-local" value="${deviceDateTime(schedule.at)}"></label>
    <label data-schedule-kind="timer interval">Duration in seconds<input name="seconds" type="number" min="1" step="0.001" required value="${seconds}"><small>At least 1 second. Decimal values support milliseconds.</small></label>
    <label data-schedule-kind="interval">First run (${escapeHtml(zone)})<input name="anchorAt" type="datetime-local" value="${deviceDateTime(schedule.anchorAt)}"><small>Leave empty to start one interval after saving.</small></label>
    <label data-schedule-kind="daily weekly monthly">Time<input name="time" type="time" value="${escapeHtml(schedule.at?.slice(0, 5) || "09:00")}"></label>
    <fieldset data-schedule-kind="weekly" class="schedule-weekdays"><legend>Weekdays</legend>${SCHEDULE_WEEKDAYS.map((day, index) => `<label><input name="weekdays" type="checkbox" value="${index}" ${schedule.weekdays?.includes(index) ? "checked" : ""}><span title="${day}">${day.slice(0, 3)}</span></label>`).join("")}</fieldset>
    <label data-schedule-kind="monthly">Day of month<input name="dayOfMonth" type="number" min="1" max="31" value="${schedule.dayOfMonth || 1}"></label>
    <label>Schedule time zone<input name="timeZone" required value="${escapeHtml(job.timeZone || zone)}" placeholder="Asia/Jerusalem"><small>Daily, weekly and monthly times use this zone.</small></label>`;
}

export function createScheduleForm({
  documentRoot,
  job,
  initialValues,
  sessions,
  models,
  modes,
  currentSessionId,
  onSave,
  onCancel,
}) {
  const form = documentRoot.createElement("form");
  form.className = "schedule-editor";
  const values = job || initialValues || {};
  const createsConversation = !job && values.newConversation === true;
  const sessionOptions = sessions.map((session) => ({
    value: session.id,
    label: session.title || session.id,
  }));
  const modelOptions = models.map((model) => ({
    value: model.id,
    label: model.label || model.name || model.id,
  }));
  if (createsConversation) {
    sessionOptions.unshift({ value: "__new_conversation__", label: "New dedicated conversation" });
  }
  if (
    job?.modelProfileId &&
    !modelOptions.some((model) => model.value === job.modelProfileId)
  ) {
    modelOptions.unshift({
      value: job.modelProfileId,
      label: `${job.modelProfileId} (unavailable)`,
    });
  }
  form.innerHTML = `
    <div class="schedule-section-heading"><h3>${job ? "Edit schedule" : "New schedule"}</h3></div>
    <label>Title<input name="title" required maxlength="200" value="${escapeHtml(values.title || "")}" placeholder="Give this task a name" dir="auto"></label>
    <label>Conversation<select name="sessionId" required ${job ? "disabled" : ""}><option value="">Choose a conversation</option>${options(sessionOptions, createsConversation ? "__new_conversation__" : values.sessionId || currentSessionId)}</select></label>
    <label>Task prompt<textarea name="prompt" rows="5" required dir="auto" placeholder="What should ABot do when this schedule runs?">${escapeHtml(values.prompt || "")}</textarea></label>
    <div class="schedule-form-grid">${scheduleFields(values)}</div>
    <div class="schedule-form-grid"><label>Model<select name="modelProfileId" required><option value="">Choose a model</option>${options(modelOptions, values.modelProfileId)}</select></label>
    <label>Mode<select name="agentMode">${options(
      modes
        .filter((mode) => mode !== "auto")
        .map((mode) => ({ value: mode, label: mode })),
      values.agentMode || "reasoning",
    )}</select></label></div>
    <p class="schedule-permission-note"><strong>Full tool access</strong> · This task runs in its conversation using the saved model and mode.</p>
    <p class="schedule-form-feedback" role="alert" hidden></p>
    <div class="schedule-action-row"><button type="submit" class="primary-button">${job ? "Save changes" : "Create schedule"}</button><button type="button" data-cancel>Cancel</button></div>`;
  const fields = form.elements;
  const feedback = form.querySelector(".schedule-form-feedback");

  function syncKind() {
    const kind = fields.namedItem("kind").value;
    for (const group of form.querySelectorAll("[data-schedule-kind]")) {
      group.hidden = !group.dataset.scheduleKind.split(" ").includes(kind);
      for (const field of group.querySelectorAll("input"))
        field.disabled = group.hidden;
    }
  }

  let initialInput;
  form.querySelector("[data-cancel]").addEventListener("click", onCancel);
  fields.namedItem("kind").addEventListener("change", syncKind);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    feedback.hidden = true;
    try {
      const currentInput = scheduleFormInput(new FormData(form), job?.schedule);
      const input = job
        ? scheduleUpdateInput(currentInput, initialInput)
        : currentInput;
      await onSave(input);
    } catch (error) {
      feedback.textContent = scheduleErrorMessage(error);
      feedback.hidden = false;
      submit.disabled = false;
    }
  });
  syncKind();
  if (job) initialInput = scheduleFormInput(new FormData(form), job.schedule);
  const initialFields = JSON.stringify([...new FormData(form)]);
  function trackScheduleDraft() {
    form.dataset.dirty = String(
      JSON.stringify([...new FormData(form)]) !== initialFields,
    );
  }
  form.addEventListener("input", trackScheduleDraft);
  form.addEventListener("change", trackScheduleDraft);
  trackScheduleDraft();
  return form;
}

export function scheduleFormInput(data, originalSchedule) {
  const value = (key) => String(data.get(key) || "").trim();
  const kind = value("kind");
  const schedule = { kind };
  if (kind === "once") {
    if (!value("onceAt")) throw new Error("Choose an exact date and time.");
    schedule.at = parseDeviceScheduleInstant(value("onceAt"));
  }
  if (kind === "timer")
    schedule.delayMs = parseDurationMilliseconds(value("seconds"));
  if (kind === "interval") {
    schedule.everyMs = parseDurationMilliseconds(value("seconds"));
    if (value("anchorAt"))
      schedule.anchorAt = intervalAnchorInput(
        value("anchorAt"),
        originalSchedule,
      );
  }
  if (["daily", "weekly", "monthly"].includes(kind)) {
    if (!value("time")) throw new Error("Choose an exact time.");
    schedule.at = value("time");
  }
  if (kind === "weekly") {
    schedule.weekdays = data.getAll("weekdays").map(Number);
    if (!schedule.weekdays.length)
      throw new Error("Choose at least one weekday.");
  }
  if (kind === "monthly") schedule.dayOfMonth = Number(value("dayOfMonth"));
  const target = value("sessionId") === "__new_conversation__"
    ? { newConversation: true }
    : { sessionId: value("sessionId") };
  return {
    ...target,
    title: value("title"),
    prompt: value("prompt"),
    modelProfileId: value("modelProfileId"),
    agentMode: value("agentMode"),
    timeZone: value("timeZone"),
    schedule,
  };
}

function intervalAnchorInput(wallTime, originalSchedule) {
  if (hasUnchangedIntervalAnchor(wallTime, originalSchedule))
    return originalSchedule.anchorAt;
  return parseDeviceScheduleInstant(wallTime);
}

function hasUnchangedIntervalAnchor(wallTime, schedule) {
  if (schedule?.kind !== "interval") return false;
  if (!schedule.anchorAt) return false;
  return deviceDateTime(schedule.anchorAt) === wallTime;
}

function formatDurationSeconds(milliseconds) {
  const duration = BigInt(milliseconds);
  const whole = String(duration / 1000n);
  const fraction = String(duration % 1000n)
    .padStart(3, "0")
    .replace(/0+$/, "");
  if (!fraction) return whole;
  return `${whole}.${fraction}`;
}

function parseDurationMilliseconds(seconds) {
  const decimal = /^(\d+)(?:\.(\d+))?$/.exec(seconds);
  if (!decimal)
    throw new Error("Enter at least 1 second, in whole milliseconds.");
  const fraction = decimal[2] || "";
  if (/[1-9]/.test(fraction.slice(3)))
    throw new Error("Enter at least 1 second, in whole milliseconds.");
  const milliseconds =
    BigInt(decimal[1]) * 1000n + BigInt(fraction.slice(0, 3).padEnd(3, "0"));
  if (milliseconds < 1000n)
    throw new Error("Enter at least 1 second, in whole milliseconds.");
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Enter at least 1 second, in whole milliseconds.");
  return Number(milliseconds);
}

function parseDeviceScheduleInstant(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new Error("Choose a valid exact date and time.");
  const instant = date.toISOString();
  if (deviceDateTime(instant) !== value)
    throw new Error(
      "This local time does not exist in your device time zone. Choose another time.",
    );
  return instant;
}

export function scheduleUpdateInput(current, initial) {
  const patch = {};
  for (const [key, value] of Object.entries(current)) {
    if (key === "sessionId") continue;
    if (JSON.stringify(value) === JSON.stringify(initial[key])) continue;
    patch[key] = value;
  }
  return patch;
}
