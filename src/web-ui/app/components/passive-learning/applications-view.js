import { learningTimeLabel } from "./presentation.js";
import { learningApplicationPreferenceChange } from "./application-actions.js";

export function learningApplicationsMarkup() {
  return `<section class="co-worker-applications" aria-label="Application permissions">
    <div class="passive-learning-section-heading"><div><h4>Applications</h4><p>Choose which apps ABot Spark can collect and review.</p></div><button type="button" data-learning-refresh>Refresh</button></div>
    <p class="co-worker-applications-note">Collect activity controls future captures. Process activity controls whether retained activity can be reviewed.</p>
    <p class="co-worker-applications-feedback" data-learning-applications-feedback role="status" aria-live="polite"></p>
    <p class="co-worker-applications-count" data-learning-applications-count></p>
    <div class="co-worker-applications-list" data-learning-applications></div>
    <p class="co-worker-applications-note">Activity blocked from processing remains pending within existing expiry and storage limits. Content already sent to a model cannot be retracted. Saved memories are kept.</p>
  </section>`;
}

export function createLearningApplications({ root, actions }) {
  const list = root.querySelector("[data-learning-applications]");
  const feedback = root.querySelector("[data-learning-applications-feedback]");
  const count = root.querySelector("[data-learning-applications-count]");
  const rows = new Map();
  let environmentId;
  let empty;

  function element(tag, className, text) {
    const node = root.ownerDocument.createElement(tag);
    node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function createRow(app) {
    const row = element("article", "co-worker-application");
    row.setAttribute("data-learning-application", app);
    const identity = element("div", "co-worker-application-identity");
    const icon = element("span", "co-worker-application-icon", Array.from(app).slice(0, 2).join("").toUpperCase());
    icon.setAttribute("aria-hidden", "true");
    const text = element("div", "co-worker-application-text");
    const title = element("h5", "", app); title.setAttribute("dir", "auto");
    const detail = element("p", "");
    text.append(title); text.append(detail); identity.append(icon); identity.append(text); row.append(identity);
    const controls = {};
    for (const [axis, label] of [["collection", "Collect activity"], ["processing", "Process activity"]]) {
      const toggle = element("label", "co-worker-setting-switch co-worker-application-toggle");
      const input = element("input", "");
      input.setAttribute("type", "checkbox");
      input.setAttribute("data-learning-application-axis", axis);
      input.setAttribute("aria-label", `${label} · ${app}`);
      toggle.append(input); toggle.append(element("span", "", label)); row.append(toggle);
      controls[axis] = input;
    }
    list.append(row);
    return { row, detail, controls };
  }

  function showEmpty(message) {
    if (!empty) { empty = element("p", "co-worker-applications-empty"); list.append(empty); }
    empty.textContent = message;
  }

  function render(snapshot) {
    if (environmentId !== snapshot.environmentId) {
      environmentId = snapshot.environmentId;
      list.replaceChildren(); rows.clear(); empty = undefined;
    }
    const applications = Array.isArray(snapshot.status?.applications) ? snapshot.status.applications : [];
    const available = Boolean(snapshot.status && Array.isArray(snapshot.status.applications));
    const disabled = snapshot.saving || snapshot.statusError || !available;
    feedback.textContent = applicationFeedback(snapshot);
    count.textContent = available ? applicationCatalogLabel(applications.length, snapshot.status.applicationsOmitted) : "";
    const current = new Set(applications.map(item => item.app));
    for (const [app, value] of rows) {
      if (current.has(app)) continue;
      value.row.remove(); rows.delete(app);
    }
    if (!applications.length) {
      showEmpty(applicationsEmptyMessage(snapshot, available));
      return;
    }
    empty?.remove(); empty = undefined;
    for (const item of applications) {
      const value = rows.get(item.app) ?? createRow(item.app);
      rows.set(item.app, value);
      value.row.setAttribute("data-learning-application-environment", String(snapshot.environmentId));
      const observations = Number.isSafeInteger(item.observationCount) ? Math.max(0, item.observationCount) : 0;
      const observed = item.lastObservedAt ? ` · Last collected ${learningTimeLabel(item.lastObservedAt)}` : "";
      value.detail.textContent = observations ? `${observations} retained ${observations === 1 ? "observation" : "observations"}${observed}` : "No retained activity";
      value.controls.collection.checked = !item.collectionExcluded;
      value.controls.processing.checked = !item.processingExcluded;
      value.controls.collection.disabled = Boolean(disabled);
      value.controls.processing.disabled = Boolean(disabled);
    }
  }

  function handleChange(event) {
    const input = event.target.closest("input[data-learning-application-axis]");
    if (!input || !root.contains(input)) return false;
    if (event.type === "input") return true;
    const row = input.closest("[data-learning-application]");
    const snapshot = actions.snapshot();
    const patch = learningApplicationPreferenceChange(snapshot, { app: row?.dataset.learningApplication,
      axis: input.dataset.learningApplicationAxis, allowed: input.checked,
      environmentId: row?.dataset.learningApplicationEnvironment });
    if (patch) void actions.configure(patch);
    render(actions.snapshot());
    return true;
  }

  return Object.freeze({ render, handleChange });
}

function applicationFeedback(snapshot) {
  if (snapshot.statusError) return "Application status is unavailable. Refresh before changing permissions.";
  if (snapshot.saving) return "Saving changes…";
  return "";
}

function applicationsEmptyMessage(snapshot, available) {
  if (snapshot.loadingStatus) return "Loading applications…";
  if (available) return "Applications appear here as activity is collected. Excluded apps stay listed.";
  return "Application history is unavailable.";
}

function applicationCatalogLabel(count, omitted) {
  const label = `${count} ${count === 1 ? "application" : "applications"} · Retained activity`;
  if (!Number.isSafeInteger(omitted) || omitted <= 0) return label;
  return `${label} · ${omitted} older applications not shown`;
}
