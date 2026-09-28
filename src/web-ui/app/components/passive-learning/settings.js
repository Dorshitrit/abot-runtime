import { learningModelLabel } from "./presentation.js";
import { hasActivityModel, readActivityPermissions } from "./activity-controls.js";

const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const checkboxFields = new Set(["collectionEnabled", "processingEnabled", "proactiveEnabled", "collectionHours", "processingHours", "proactiveHours"]);
const integerLimits = { analysisIntervalMinutes: [1, 1440], analysisObservationCount: [1, 256], proactiveIntervalMinutes: [1, 1440],
  proactiveMessagesPerDay: [1, 100], maxConcurrentBatches: [1, 8], modelCallsPerDay: [1, Number.MAX_SAFE_INTEGER],
  embeddingCallsPerDay: [1, Number.MAX_SAFE_INTEGER], embeddingCharactersPerDay: [1, Number.MAX_SAFE_INTEGER],
  promotionScore: [0, 100], retentionDays: [1, 365], maxCandidates: [1, 5000] };

function savedSettings(preferences = {}) {
  const limits = preferences.resourceLimits || {}, maturation = preferences.maturation || {};
  const permissions = readActivityPermissions(preferences);
  const values = { collectionEnabled: permissions.collection, processingEnabled: permissions.learning,
    proactiveEnabled: permissions.proactive, modelProfileId: preferences.modelProfileId || "",
    proactiveModelProfileId: preferences.proactiveModelProfileId || "",
    analysisTrigger: preferences.analysisTrigger ?? "interval", analysisObservationCount: preferences.analysisObservationCount ?? 100,
    analysisIntervalMinutes: preferences.analysisIntervalMinutes ?? 15, proactiveIntervalMinutes: preferences.proactiveIntervalMinutes ?? 60,
    proactiveMessagesPerDay: preferences.proactiveMessagesPerDay ?? 2, maxConcurrentBatches: preferences.maxConcurrentBatches ?? limits.maxConcurrentCalls ?? 1,
    modelCallsPerDay: limits.modelCallsPerDay ?? 24, embeddingCallsPerDay: limits.embeddingCallsPerDay ?? 96,
    embeddingCharactersPerDay: limits.embeddingCharactersPerDay ?? 1048576, budgetTimeZone: limits.timeZone || "UTC",
    promotionScore: maturation.promotionScore ?? 90, retentionDays: maturation.retentionDays ?? 30,
    maxCandidates: maturation.maxCandidates ?? 500, candidateMiB: (maturation.maxBytes ?? 2097152) / 1048576 };
  for (const [axis, window] of [["collection", preferences.collectionWindow], ["processing", preferences.analysisWindow], ["proactive", preferences.proactiveWindow]]) {
    Object.assign(values, { [`${axis}Hours`]: Boolean(window), [`${axis}Start`]: window?.start || "09:00",
      [`${axis}End`]: window?.end || "17:00", [`${axis}TimeZone`]: window?.timeZone || timeZone() });
  }
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, checkboxFields.has(key) ? value : String(value)]));
}

function preferencesFrom(values) {
  const window = (axis) => values[`${axis}Hours`] ? { start: values[`${axis}Start`], end: values[`${axis}End`], timeZone: values[`${axis}TimeZone`].trim() } : null;
  return { activityPermissions: { collection: values.collectionEnabled, learning: values.processingEnabled, proactive: values.proactiveEnabled },
    ...(values.modelProfileId ? { modelProfileId: values.modelProfileId } : {}),
    proactiveModelProfileId: values.proactiveModelProfileId || null,
    analysisTrigger: values.analysisTrigger,
    ...(values.analysisTrigger === "observations" ? { analysisObservationCount: Number(values.analysisObservationCount) }
      : { analysisIntervalMinutes: Number(values.analysisIntervalMinutes) }),
    analysisWindow: window("processing"), collectionWindow: window("collection"),
    proactiveIntervalMinutes: Number(values.proactiveIntervalMinutes), proactiveWindow: window("proactive"),
    proactiveMessagesPerDay: Number(values.proactiveMessagesPerDay), maxConcurrentBatches: Number(values.maxConcurrentBatches),
    resourceLimits: { modelCallsPerDay: Number(values.modelCallsPerDay), embeddingCallsPerDay: Number(values.embeddingCallsPerDay),
      embeddingCharactersPerDay: Number(values.embeddingCharactersPerDay), maxConcurrentCalls: Number(values.maxConcurrentBatches), timeZone: values.budgetTimeZone.trim() },
    maturation: { promotionScore: Number(values.promotionScore), retentionDays: Number(values.retentionDays),
      maxCandidates: Number(values.maxCandidates), maxBytes: Number(values.candidateMiB) * 1048576 } };
}

function isInactiveLearningSetting(key, values) {
  if (key === "analysisObservationCount") return values.analysisTrigger !== "observations";
  if (key === "analysisIntervalMinutes") return values.analysisTrigger === "observations";
  return false;
}

export function createLearningSettings({ root, actions, openSettings = () => {} }) {
  let environment;
  let committed = savedSettings();
  let values = { ...committed };
  let modelOptionsKey = "";
  let feedback = "";
  const form = root.querySelector("[data-learning-settings]");
  const input = (key) => root.querySelector(`[data-learning-setting="${key}"]`);
  const changed = () => Object.keys(values).some((key) => values[key] !== committed[key]);

  function models(profiles = []) {
    const key = JSON.stringify(profiles.map((profile) => [profile.id, profile.label, profile.providerId, profile.provider]));
    if (key === modelOptionsKey) return;
    modelOptionsKey = key;
    for (const name of ["modelProfileId", "proactiveModelProfileId"]) {
      const select = input(name); select.replaceChildren();
      const append = (label, id) => { const option = root.ownerDocument.createElement("option"); option.textContent = label; option.value = id; select.append(option); };
      append(name === "proactiveModelProfileId" ? "Same as learning" : "Choose a model", "");
      for (const profile of profiles) if (typeof profile.id === "string") append(learningModelLabel(profile), profile.id);
    }
  }

  function render(snapshot) {
    const next = savedSettings(snapshot.status?.preferences);
    if (snapshot.environmentId !== environment) {
      environment = snapshot.environmentId; values = { ...next }; committed = next; feedback = ""; modelOptionsKey = "";
    } else if (snapshot.status) {
      for (const key of Object.keys(next)) if (values[key] === committed[key]) values[key] = next[key];
      committed = next;
    }
    models(snapshot.models || []);
    for (const [key, value] of Object.entries(values)) {
      const element = input(key);
      if (!element) continue;
      if (checkboxFields.has(key)) element.checked = value;
      else {
        if (element.tagName === "SELECT" && value && ![...element.querySelectorAll("option")].some((option) => option.value === value)) {
          const option = root.ownerDocument.createElement("option"); option.value = value; option.textContent = `${value} · unavailable`; element.append(option);
        }
        if (element.value !== value) element.value = value;
      }
      element.disabled = snapshot.saving || !snapshot.status || isInactiveLearningSetting(key, values);
    }
    for (const mode of ["interval", "observations"])
      root.querySelector(`[data-learning-trigger-for="${mode}"]`).hidden = values.analysisTrigger !== mode;
    for (const axis of ["collection", "processing", "proactive"]) {
      const window = root.querySelector(`[data-learning-window-for="${axis}"]`);
      window.hidden = !values[`${axis}Hours`];
      for (const element of window.querySelectorAll("input")) element.disabled ||= window.hidden;
      root.querySelector(`[data-learning-settings-axis="${axis}"]`).dataset.enabled = String(values[`${axis}Enabled`]);
    }
    for (const save of root.querySelectorAll("[data-learning-save]")) {
      save.textContent = snapshot.saving ? "Saving…" : "Save settings";
      save.disabled = snapshot.saving || !snapshot.status || !changed();
    }
    root.querySelector("[data-learning-settings-feedback]").textContent = feedback || (changed() ? "Unsaved changes" : "");
  }

  function handleChange(event) {
    if (!form?.contains(event.target)) return false;
    const key = event.target.dataset.learningSetting;
    if (!Object.hasOwn(values, key)) return false;
    values[key] = checkboxFields.has(key) ? event.target.checked : event.target.value;
    feedback = "";
    render(actions.snapshot());
    return true;
  }

  function invalid(key, message) {
    feedback = message; openSettings(); input(key)?.focus(); render(actions.snapshot()); return false;
  }
  function validate() {
    const profiles = actions.snapshot().models || [];
    if ((values.collectionEnabled || values.processingEnabled) && !hasActivityModel("learning", values, profiles))
      return invalid("modelProfileId", "Choose an available learning model first.");
    if (values.proactiveEnabled && !hasActivityModel("proactive", values, profiles))
      return invalid("proactiveModelProfileId", "Choose an available model for proactive mode.");
    for (const key of Object.keys(integerLimits)) {
      if (isInactiveLearningSetting(key, values)) continue;
      const number = Number(values[key]), [minimum, maximum] = integerLimits[key];
      if (!Number.isSafeInteger(number) || number < minimum || number > maximum)
        return invalid(key, `Enter a whole number between ${minimum} and ${maximum}.`);
    }
    const bytes = Number(values.candidateMiB) * 1048576;
    if (!Number.isSafeInteger(bytes) || bytes < 1024 || bytes > 20971520)
      return invalid("candidateMiB", "Set a candidate limit between 1 KiB and 20 MiB, in whole bytes.");
    const zones = ["budgetTimeZone"];
    for (const axis of ["collection", "processing", "proactive"]) {
      if (!values[`${axis}Hours`]) continue;
      for (const suffix of ["Start", "End"]) if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(values[`${axis}${suffix}`]))
        return invalid(`${axis}${suffix}`, "Choose a valid start and end time.");
      zones.push(`${axis}TimeZone`);
    }
    for (const key of zones) {
      try { new Intl.DateTimeFormat("en-US", { timeZone: values[key].trim() }).format(0); }
      catch { return invalid(key, "Enter a valid time zone, such as Asia/Jerusalem."); }
    }
    if (form.checkValidity?.() === false) { openSettings(); form.reportValidity?.(); return false; }
    return true;
  }

  async function saveSettings() {
    const draft = values, submitted = { ...values };
    const status = await actions.configure(preferencesFrom(submitted));
    if (!status?.preferences || values !== draft) return;
    const saved = savedSettings(status.preferences);
    for (const key of Object.keys(submitted)) {
      if (!isInactiveLearningSetting(key, submitted)) continue;
      if (values[key] === submitted[key]) values[key] = saved[key];
    }
    render(actions.snapshot());
  }

  function handleSubmit(event) {
    if (event.target !== form) return false;
    event.preventDefault();
    const snapshot = actions.snapshot();
    if (snapshot.saving || !snapshot.status) return true;
    render(snapshot);
    if (validate()) void saveSettings();
    return true;
  }

  return Object.freeze({ render, handleChange, handleSubmit, draft: () => preferencesFrom(values) });
}
