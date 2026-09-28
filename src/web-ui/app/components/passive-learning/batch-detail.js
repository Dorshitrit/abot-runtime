import { learningTimeLabel } from "./presentation.js";
import { learningFailureCopy } from "./failure-copy.js";
import { renderLearningDiagnostics } from "./diagnostics-view.js";

const batchStatusLabels = Object.freeze({
  pending: "Waiting",
  processing: "Reviewing",
  saved: "Completed",
  reviewed: "Candidates updated",
  discarded: "Discarded",
  failed: "Failed",
  cancelled: "Cancelled",
});

export function learningBatchStatusLabel(status) {
  return batchStatusLabels[status] || "Status unavailable";
}

function observationKindLabel(kind) {
  if (kind === "edit") return "Text changed";
  if (kind === "activity") return "Returned to this app";
  return "Viewed";
}

function observationText(observation) {
  if (typeof observation.content === "string" && observation.content.trim())
    return observation.content;
  if (observation.revisit?.contentUnchanged || observation.revisitsObservationId)
    return "No new text since the previous view.";
  if (observation.kind === "activity")
    return "Activity was observed without new text.";
  return "This app did not expose readable text for this observation.";
}

function renderObservation(container, observation) {
  const documentRoot = container.ownerDocument;
  const element = (tag, className, text) => {
    const node = documentRoot.createElement(tag);
    node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const item = documentRoot.createElement("details");
  item.className = "passive-learning-observation";
  const summary = documentRoot.createElement("summary");
  const app = observation.source?.app || "Unknown app";
  const icon = element("span", "passive-learning-observation-icon", Array.from(app).slice(0, 2).join("").toUpperCase());
  icon.setAttribute("aria-hidden", "true");
  const heading = element("div", "passive-learning-observation-heading");
  const labels = element("div", "passive-learning-observation-labels");
  labels.append(element("span", "passive-learning-observation-app", app));
  labels.append(element("span", "passive-learning-observation-kind", observationKindLabel(observation.kind)));
  const source = element("span", "passive-learning-observation-source", observation.source?.title || "Untitled window");
  source.setAttribute("dir", "auto");
  const time = element("time", "passive-learning-observation-meta", learningTimeLabel(observation.timestamp));
  if (Number.isFinite(Date.parse(observation.timestamp || ""))) time.setAttribute("datetime", observation.timestamp);
  heading.append(labels);
  heading.append(source);
  heading.append(time);
  summary.append(icon);
  summary.append(heading);

  const body = element("div", "passive-learning-observation-body");
  const readable = typeof observation.content === "string" && observation.content.trim();
  if (readable) body.append(element("p", "passive-learning-observation-content-label", "Captured text"));
  const content = documentRoot.createElement("pre");
  content.setAttribute("dir", "auto");
  content.setAttribute("tabindex", "0");
  content.setAttribute("aria-label", readable ? "Captured text" : "Observation context");
  content.textContent = observationText(observation);
  body.append(content);
  const diagnostics = [observation.coverage, observation.coverageReason]
    .filter(Boolean).join(" · ");
  if (diagnostics) {
    const note = element("details", "passive-learning-observation-diagnostics");
    note.append(element("summary", "", "Capture details"));
    note.append(element("code", "", diagnostics));
    body.append(note);
  }
  item.append(summary);
  item.append(body);
  container.append(item);
}

export function renderLearningBatchDetail(container, snapshot) {
  container.hidden = !snapshot.selectedBatchId;
  if (container.hidden) return;
  container.replaceChildren();
  if (snapshot.loadingDetail) {
    container.textContent = "Loading review details…";
    return;
  }
  if (snapshot.detailError) {
    container.textContent = "Review details could not be loaded. Refresh to try again.";
    return;
  }
  const batch = snapshot.selectedBatch;
  if (!batch) return;
  const observations = Array.isArray(batch.observations) ? batch.observations : [];
  const documentRoot = container.ownerDocument;
  const header = documentRoot.createElement("header");
  header.className = "passive-learning-detail-header";
  const heading = documentRoot.createElement("h5");
  heading.textContent = "Review details";
  const summary = documentRoot.createElement("p");
  const observationLabel = observations.length === 1 ? "observation" : "observations";
  summary.textContent = `${learningBatchStatusLabel(batch.status)} · ${observations.length} ${observationLabel} · ${batch.recordIds?.length || 0} saved · ${batch.candidateIds?.length || 0} candidates`;
  header.append(heading);
  header.append(summary);
  const close = documentRoot.createElement("button");
  close.setAttribute("type", "button");
  close.setAttribute("data-learning-batch", "");
  close.textContent = "Close details";
  header.append(close);
  container.append(header);
  if (batch.reason || batch.status === "failed") {
    const explanation = learningFailureCopy(batch.reason);
    const reason = documentRoot.createElement("p");
    reason.className = "passive-learning-detail-reason";
    reason.textContent = explanation.message;
    container.append(reason);
    if (explanation.code) {
      const details = documentRoot.createElement("details");
      details.className = "passive-learning-diagnostics";
      const label = documentRoot.createElement("summary");
      label.textContent = "Technical details";
      const codes = documentRoot.createElement("dl");
      codes.className = "passive-learning-diagnostic-list";
      renderLearningDiagnostics(codes, [explanation.code]);
      details.append(label);
      details.append(codes);
      container.append(details);
    }
  }
  if (!observations.length) {
    const empty = documentRoot.createElement("p");
    empty.textContent = "No observations were included in this batch.";
    container.append(empty);
    return;
  }
  for (const observation of observations)
    renderObservation(container, observation);
}
