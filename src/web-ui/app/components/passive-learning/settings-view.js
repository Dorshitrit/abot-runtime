import { escapeAttribute } from "../../lib/text-format.js";

function field(key, label, { type = "number", value = "", min = 1, max, legacy = "", step = "1", options } = {}) {
  const attrs = `data-learning-setting="${key}" ${legacy ? `data-learning-${legacy}` : ""}`;
  const control = type === "select"
    ? `<select ${attrs} aria-label="${label}">${options || '<option value="">Choose a model</option>'}</select>`
    : `<input ${attrs} type="${type}" value="${escapeAttribute(value)}" ${type === "number" ? `min="${min}" step="${step}" ${max ? `max="${max}"` : ""}` : ""} ${type === "text" ? 'autocomplete="off" maxlength="100"' : ""} required />`;
  return `<label class="co-worker-setting-field">${label}${control}</label>`;
}

function toggle(key, label, legacy = "", small = false) {
  return `<label class="${small ? "co-worker-hours-toggle" : "co-worker-setting-switch"}"><input type="checkbox" data-learning-setting="${key}" ${legacy ? `data-learning-${legacy}` : ""} /><span>${label}</span></label>`;
}

function windowFields(axis, timeZone) {
  const legacy = axis === "processing" ? "" : `${axis}-`;
  return `${toggle(`${axis}Hours`, "Set activity hours", `${legacy}hours`, true)}
    <div class="co-worker-window-fields" data-learning-window-for="${axis}" data-learning-${legacy}window hidden>
      <div class="co-worker-setting-pair">${field(`${axis}Start`, "From", { type: "time", value: "09:00", legacy: `${legacy}start` })}
      ${field(`${axis}End`, "Until", { type: "time", value: "17:00", legacy: `${legacy}end` })}</div>
      ${field(`${axis}TimeZone`, "Time zone", { type: "text", value: timeZone, legacy: `${legacy}time-zone` })}
    </div>`;
}

export function learningSettingsMarkup(timeZone = "UTC") {
  return `<form class="passive-learning-settings co-worker-settings" data-learning-settings>
    <div class="co-worker-settings-header">
      <div class="co-worker-settings-intro"><h4>Activity permissions</h4><p>Choose what Spark may do. Saving permission does not start an activity; use its Start button when you are ready.</p></div>
      <button type="submit" data-learning-save disabled>Save settings</button>
    </div>
    <div class="co-worker-settings-grid">
      <section class="co-worker-settings-card" data-learning-settings-axis="collection">
        <h4>Collection</h4><p>Notice changes in your active applications.</p>
        ${toggle("collectionEnabled", "Allow collection", "collection-enabled")}
        ${windowFields("collection", timeZone)}
        <p class="co-worker-setting-note">Revoking permission stops collection. Pending observations keep their existing retention limit.</p>
      </section>
      <section class="co-worker-settings-card" data-learning-settings-axis="processing">
        <h4>Learning</h4><p>Review activity and refine what ABot Spark knows.</p>
        ${toggle("processingEnabled", "Allow learning", "processing-enabled")}
        ${field("modelProfileId", "Learning model", { type: "select", legacy: "model" })}
        ${field("analysisTrigger", "Start a review", { type: "select", options: '<option value="interval">By time</option><option value="observations">By observation count</option>' })}
        <div data-learning-trigger-for="interval">${field("analysisIntervalMinutes", "Review interval (minutes)", { value: 15, max: 1440, legacy: "interval" })}</div>
        <div data-learning-trigger-for="observations" hidden>${field("analysisObservationCount", "Eligible observations waiting", { value: 100, max: 256 })}
          <p class="co-worker-setting-note">Reviews waiting observations in small batches. Starts earlier if eligible activity nears the storage limit. New observations wait for the next review; blocked apps do not count. Hours, budgets and retention still apply.</p></div>
        ${windowFields("processing", timeZone)}
        <p class="co-worker-setting-note">Runs only when there is eligible work. Pausing keeps pending observations within their retention limit.</p>
      </section>
      <section class="co-worker-settings-card" data-learning-settings-axis="proactive">
        <h4>Proactive mode</h4><p>Start a conversation when there is something useful to offer.</p>
        ${toggle("proactiveEnabled", "Allow proactive mode", "proactive-enabled")}
        ${field("proactiveModelProfileId", "Proactive model", { type: "select", legacy: "proactive-model" })}
        ${field("proactiveIntervalMinutes", "Check interval (minutes)", { value: 60, max: 1440, legacy: "proactive-interval" })}
        ${windowFields("proactive", timeZone)}
        <p class="co-worker-setting-note">Can use existing knowledge while collection is off. Messages only; actions need your approval.</p>
      </section>
    </div>
    <section class="co-worker-settings-limits">
      <div class="co-worker-settings-intro"><h4>Shared limits</h4><p>Learning and proactive reviews share this daily budget. Failed attempts count too.</p></div>
      <div class="co-worker-limits-grid">
        ${field("modelCallsPerDay", "Model calls per day", { value: 24 })}
        ${field("proactiveMessagesPerDay", "Proactive messages per day", { value: 2, max: 100 })}
        ${field("maxConcurrentBatches", "Concurrent cloud calls", { value: 1, max: 8, legacy: "concurrency" })}
        ${field("embeddingCallsPerDay", "Embedding calls per day", { value: 96 })}
        ${field("embeddingCharactersPerDay", "Embedding input characters per day", { value: 1048576 })}
        ${field("budgetTimeZone", "Daily budget time zone", { type: "text", value: "UTC" })}
      </div>
      <p class="co-worker-setting-note">Local models run one call at a time. A time-zone change does not reset the current budget.</p>
    </section>
    <details class="co-worker-settings-limits co-worker-memory-policy">
      <summary>When a candidate becomes memory</summary>
      <p class="co-worker-setting-note">Applies to automatic learning from conversations and computer activity. Promotion needs your chosen score and two independent reinforcements. Scores express model judgment, not probability.</p>
      <div class="co-worker-limits-grid">
        ${field("promotionScore", "Promotion score (out of 100)", { value: 90, min: 0, max: 100 })}
        ${field("retentionDays", "Days without reinforcement", { value: 30, max: 365 })}
        ${field("maxCandidates", "Maximum candidates", { value: 500, max: 5000 })}
        ${field("candidateMiB", "Candidate storage limit (MiB)", { value: 2, min: 0.0009765625, max: 20, step: "any" })}
      </div>
    </details>
    <div class="co-worker-settings-footer"><span data-learning-settings-feedback role="status" aria-live="polite"></span><button type="submit" data-learning-save disabled>Save settings</button></div>
  </form>`;
}
