function quota(key, title, note) {
  return `<div class="co-worker-usage-row"><div class="co-worker-usage-heading"><div><span>${title}</span><small>${note}</small></div><span class="co-worker-usage-value" data-learning-usage-value="${key}">—</span></div>
    <div class="co-worker-usage-meter" data-learning-usage-meter="${key}" role="progressbar" aria-label="${title}" aria-valuemin="0" hidden><span></span></div></div>`;
}

export function learningUsageMarkup() {
  return `<section class="co-worker-usage" data-learning-usage aria-label="ABot Spark resource use">
    <div class="co-worker-usage-header"><div><h4>Today's resource use</h4><p data-learning-usage-reset>Waiting for usage…</p></div><button type="button" data-learning-open-settings>Edit limits</button></div>
    ${quota("model", "Model calls", "Learning and proactive reviews. Failed attempts count too.")}
    ${quota("messages", "Proactive messages", "New conversations started by ABot Spark.")}
    ${quota("active", "Concurrent model calls", "Local models run one call at a time.")}
    ${quota("embedding", "Embedding calls", "Separate from the model-call budget.")}
    ${quota("characters", "Embedding input characters", "The shared daily input allowance.")}
    ${quota("candidates", "Candidates", "Provisional knowledge, before it becomes memory.")}
    <div class="co-worker-usage-row"><div class="co-worker-usage-heading"><div><span>Candidate storage limit</span><small>Maximum space available for candidates.</small></div><span class="co-worker-usage-value" data-learning-usage-storage>—</span></div></div>
    <div class="co-worker-usage-row"><div class="co-worker-usage-heading"><div><span>Pending observations</span><small data-learning-usage-retention>Kept within their retention limit.</small></div><span class="co-worker-usage-value" data-learning-usage-pending>—</span></div></div>
    <p class="co-worker-setting-note">Usage is reported by the runtime. No model calls are made to display these counters.</p>
  </section>`;
}

const count = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const format = (value) => new Intl.NumberFormat().format(value);
function bytes(value) {
  return value >= 1048576 ? `${format(value / 1048576)} MiB` : `${format(value / 1024)} KiB`;
}

export function renderResourceUsage(root, snapshot) {
  const container = root.matches?.("[data-learning-usage]") ? root : root.querySelector("[data-learning-usage]");
  if (!container) return;
  const status = snapshot.status, preferences = status?.preferences || {};
  const usage = status?.resourceUsage, limits = preferences.resourceLimits || {}, maturation = preferences.maturation || {};
  const text = (selector, value) => { const element = container.querySelector(selector); if (element.textContent !== value) element.textContent = value; };
  function showQuota(key, used, maximum) {
    const current = count(used), cap = count(maximum);
    text(`[data-learning-usage-value="${key}"]`, current === null ? `Count unavailable · limit ${format(cap ?? 0)}` : `${format(current)} / ${format(cap ?? 0)}`);
    const meter = container.querySelector(`[data-learning-usage-meter="${key}"]`);
    meter.hidden = current === null || !cap;
    if (meter.hidden) { meter.removeAttribute("aria-valuenow"); return; }
    meter.setAttribute("aria-valuemax", String(cap)); meter.setAttribute("aria-valuenow", String(Math.min(current, cap)));
    meter.setAttribute("aria-valuetext", `${format(current)} of ${format(cap)}`);
    meter.setAttribute("style", `--co-worker-usage: ${Math.min(1, current / cap)}`);
  }
  showQuota("model", usage?.modelCalls, limits.modelCallsPerDay ?? 24);
  showQuota("messages", status?.proactive?.deliveredToday, preferences.proactiveMessagesPerDay ?? 2);
  showQuota("active", usage?.activeCalls, preferences.maxConcurrentBatches ?? limits.maxConcurrentCalls ?? 1);
  showQuota("embedding", usage?.embeddingCalls, limits.embeddingCallsPerDay ?? 96);
  showQuota("characters", usage?.embeddingCharacters, limits.embeddingCharactersPerDay ?? 1048576);
  const candidates = snapshot.loadingCandidates || snapshot.candidateError || !Array.isArray(snapshot.candidates) ? undefined : snapshot.candidates.length;
  showQuota("candidates", candidates, maturation.maxCandidates ?? 500);
  text("[data-learning-usage-storage]", `Up to ${bytes(maturation.maxBytes ?? 2097152)}`);
  text("[data-learning-usage-pending]", count(status?.pendingObservations) === null ? "—" : format(status.pendingObservations));
  text("[data-learning-usage-retention]", `Kept for up to ${format(status?.retentionHours ?? 24)} hours from collection.`);
  let reset = "Current usage is unavailable.";
  if (usage && Number.isFinite(usage.resetsAt)) {
    const zone = usage.timeZone || limits.timeZone || "UTC";
    try { reset = `Next reset ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: zone }).format(usage.resetsAt)} · ${zone}`; }
    catch { reset = `Next reset ${new Date(usage.resetsAt).toISOString()}`; }
  }
  text("[data-learning-usage-reset]", reset);
}
