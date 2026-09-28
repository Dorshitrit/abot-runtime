import { renderAgent } from "./agent-view.js";
import { renderComputerUpdateNotice } from "./computer-update-notice.js";
import { renderMacCollectionRestartNotice, handleMacCollectionRestartClick } from "./macos-collection-restart-notice.js";
import { learningCadenceLabel } from "./agent-state.js";
import { renderLearningDiagnostics } from "./diagnostics-view.js";
import { isObservationReviewActive } from "./processing-state.js";
import { createAgentMotion } from "./agent-motion.js";
import { createLearningSettings } from "./settings.js";
import { handleActivityControlClick, renderActivityControls } from "./activity-controls.js";
import { createLearningApplications } from "./applications-view.js";
import { renderResourceUsage } from "./usage-view.js";
import { renderLearningKnowledge, handleKnowledgeClick } from "./knowledge-view.js";
import { renderLearningProposals, handleProposalClick } from "./proposal-view.js";
import { escapeAttribute, escapeHtml } from "../../lib/text-format.js";
import { learningBatchStatusLabel, renderLearningBatchDetail } from "./batch-detail.js";
import { learningWorkspaceMarkup, navigateLearningTabs, selectLearningView } from "./workspace-view.js";
import {
  learningCoveragePresentation,
  learningFailurePresentation,
  learningProcessingLabel,
  learningRetentionText,
  hasUnprocessedLearningActivity,
  learningTimeLabel,
} from "./presentation.js";

const defaultTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export function createPassiveLearningMemory({
  actions, showActivityMemories, openComputerAccess,
  confirmDelete = (message) => window.confirm(message),
}) {
  let root = null;
  let settings;
  let applications;
  let motion;
  let displayedBatch = null;
  let displayedBatchId = "";
  let displayedDetailError = "";
  let displayedDetailLoading = false;
  let lastBatchMarkup = "";

  function mount(nextRoot) {
    if (root === nextRoot) return;
    motion?.dispose();
    root?.removeEventListener("click", handleClick);
    root?.removeEventListener("submit", handleSubmit);
    root?.removeEventListener("change", handleChange);
    root?.removeEventListener("input", handleChange);
    root?.removeEventListener("keydown", handleKeyDown);
    root = nextRoot;
    if (!root) return;
    displayedBatch = null;
    displayedBatchId = "";
    lastBatchMarkup = "";
    root.innerHTML = learningWorkspaceMarkup(defaultTimeZone());
    settings = createLearningSettings({ root, actions, openSettings: () => selectLearningView(root, "settings") });
    applications = createLearningApplications({ root, actions });
    motion = createAgentMotion(root);
    root.addEventListener("click", handleClick);
    root.addEventListener("submit", handleSubmit);
    root.addEventListener("change", handleChange);
    root.addEventListener("input", handleChange);
    root.addEventListener("keydown", handleKeyDown);
    render(actions.snapshot());
  }

  function handleChange(event) {
    if (applications.handleChange(event)) return;
    settings.handleChange(event); renderControls(actions.snapshot());
  }
  function handleSubmit(event) { settings.handleSubmit(event); }

  function handleKeyDown(event) {
    navigateLearningTabs(root, event);
  }

  function handleClick(event) {
    if (handleActivityControlClick(root, event, actions, () => selectLearningView(root, "settings"))) return;
    if (handleMacCollectionRestartClick(root, event, actions)) return;
    if (handleKnowledgeClick(root, event)) return;
    if (handleProposalClick(root, event, actions)) return;
    if (event.target.closest("[data-learning-open-settings]")) {
      selectLearningView(root, "settings", true);
      return;
    }
    const tab = event.target.closest("button[data-learning-tab]");
    if (tab && root.contains(tab)) {
      selectLearningView(root, tab.dataset.learningTab);
      return;
    }
    const clearPending = event.target.closest("button[data-learning-clear-pending]");
    if (clearPending && root.contains(clearPending)) {
      deletePending();
      return;
    }
    const setupButton = event.target.closest("button[data-learning-open-setup]") ??
      event.target.closest("button[data-learning-open-update]") ??
      event.target.closest("button[data-learning-computer-access]");
    if (setupButton && root.contains(setupButton)) {
      openComputerAccess();
      return;
    }
    const button = event.target.closest("button[data-learning-refresh], button[data-learning-batch], button[data-learning-memories]");
    if (!button || !root.contains(button)) return;
    if (button.hasAttribute("data-learning-refresh")) void actions.refresh();
    if (button.hasAttribute("data-learning-batch")) {
      const previousId = actions.snapshot().selectedBatchId;
      const nextId = button.dataset.learningBatch;
      void actions.selectBatch(nextId);
      if (!nextId) {
        const previousButton = [...root.querySelectorAll("[data-learning-batches] button")]
          .find((item) => item.dataset.learningBatch === previousId);
        previousButton?.focus({ preventScroll: true });
      }
    }
    if (button.hasAttribute("data-learning-memories"))
      showActivityMemories();
  }

  function deletePending() {
    const snapshot = actions.snapshot();
    if (!snapshot.status || snapshot.saving) return;
    if (!hasUnprocessedLearningActivity(snapshot.status)) return;
    if (!confirmDelete("Delete all pending activity, including any review in progress? Saved insights are kept. This cannot be undone.")) return;
    void actions.clearPending();
  }


  function renderControls(snapshot) {
    const status = snapshot.status;
    const disabled = snapshot.saving || !status;
    renderActivityControls(root, snapshot);
    root.querySelector("[data-learning-clear-pending]").disabled = disabled || !hasUnprocessedLearningActivity(status);
  }

  function renderStatus(snapshot) {
    const status = snapshot.status;
    const companion = snapshot.hostConnection?.companion;
    renderComputerUpdateNotice(root, snapshot);
    renderMacCollectionRestartNotice(root, snapshot);
    root.querySelector("[data-learning-companion-version]").textContent = companion
      ? `Installed version: ${companion.installedVersion ?? "unversioned"} · Available: ${companion.availableVersion}` : "Connect your computer to check its companion version.";
    const attention = learningFailurePresentation(status);
    const coverage = learningCoveragePresentation(status);
    root.querySelector("[data-learning-attention]").hidden = !attention;
    root.querySelector("[data-learning-attention-text]").textContent = attention?.message || "";
    root.querySelector("[data-learning-open-setup]").hidden = !attention?.connectComputer;
    root.querySelector("[data-learning-processing-status]").textContent = learningProcessingLabel(status);
    root.querySelector("[data-learning-retention]").textContent = learningRetentionText(status);
    const modelId = status?.preferences?.modelProfileId;
    const model = snapshot.models.find((profile) => profile.id === modelId);
    root.querySelector("[data-learning-schedule-summary]").textContent = modelId
      ? `${model?.label || modelId} · ${learningCadenceLabel(status.preferences)}`
      : "Choose a model in Settings to get started.";
    root.querySelector("[data-learning-device]").textContent = status?.deviceId || "Not connected now";
    root.querySelector("[data-learning-coverage]").textContent = coverage.label;
    root.querySelector("[data-learning-coverage-detail]").textContent = coverage.detail;
    const reasons = [status?.collectionReason, status?.processingReason, status?.reason, status?.proactive?.reason, status?.reassessment?.reason, status?.maintenanceReason].filter(Boolean);
    root.querySelector("[data-learning-diagnostics]").hidden = !reasons.length;
    renderLearningDiagnostics(root.querySelector("[data-learning-reason]"), reasons);
    root.querySelector("[data-learning-observation]").textContent =
      learningTimeLabel(status?.lastObservationAt);
    root.querySelector("[data-learning-pending]").textContent = status
      ? `${status.pendingObservations || 0} waiting${status.droppedObservations ? ` · ${status.droppedObservations} dropped` : ""}`
      : "—";
    const processingActive = !snapshot.statusError && isObservationReviewActive(status);
    root.querySelector("[data-learning-pending-fact]").setAttribute("data-processing-active", String(processingActive));
    root.querySelector("[data-learning-processing-badge]").hidden = !processingActive;
    root.querySelector("[data-learning-analysis]").textContent = status
      ? `${status.activeBatches ?? 0} active · ${status.effectiveConcurrency ?? 1} parallel${status.nextAnalysisAt ? ` · next ${learningTimeLabel(status.nextAnalysisAt)}` : ""}`
      : "—";
    const feedback = snapshot.statusError || snapshot.modelsError || snapshot.batchError;
    root.querySelector("[data-learning-feedback]").textContent = feedback ||
      (snapshot.loadingStatus ? "Loading learning status…" : "");
  }

  function renderBatches(snapshot) {
    const list = root.querySelector("[data-learning-batches]");
    if (snapshot.loadingBatches && !snapshot.batches.length) {
      lastBatchMarkup = "";
      list.textContent = "Loading reviews…";
      return;
    }
    if (!snapshot.batches.length) {
      lastBatchMarkup = "";
      list.textContent = "No activity has been reviewed yet.";
      return;
    }
    const markup = snapshot.batches.map((batch) =>
      `<button type="button" class="passive-learning-batch" data-learning-batch="${escapeAttribute(batch.id)}" aria-pressed="${batch.id === snapshot.selectedBatchId}">
        <span class="passive-learning-batch-heading"><time datetime="${escapeAttribute(batch.createdAt)}">${escapeHtml(learningTimeLabel(batch.createdAt))}</time><span>${escapeHtml(learningBatchStatusLabel(batch.status))}</span></span>
        <small>${Number(batch.observationCount) || 0} observations · ${batch.recordIds?.length || 0} saved · ${batch.candidateIds?.length || 0} candidates</small>
      </button>`).join("");
    if (lastBatchMarkup !== markup) {
      lastBatchMarkup = markup;
      list.innerHTML = markup;
    }
  }

  function renderBatchDetail(snapshot) {
    const container = root.querySelector("[data-learning-detail]");
    const batch = snapshot.selectedBatch;
    if (snapshot.selectedBatchId === displayedBatchId &&
        batch === displayedBatch &&
        snapshot.detailError === displayedDetailError &&
        snapshot.loadingDetail === displayedDetailLoading) return;
    displayedBatchId = snapshot.selectedBatchId;
    displayedBatch = batch;
    displayedDetailError = snapshot.detailError;
    displayedDetailLoading = snapshot.loadingDetail;
    renderLearningBatchDetail(container, snapshot);
  }

  function render(snapshot) {
    if (!root) return;
    settings.render(snapshot);
    applications.render(snapshot);
    renderControls(snapshot);
    renderAgent(root, snapshot);
    motion.update(snapshot);
    renderStatus(snapshot);
    renderBatches(snapshot);
    renderBatchDetail(snapshot);
    renderLearningKnowledge(root, snapshot);
    renderLearningProposals(root, snapshot);
    renderResourceUsage(root, snapshot);
  }

  function focus() {
    root?.querySelector("[data-learning-heading]")?.focus({ preventScroll: true });
    root?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  return Object.freeze({ mount, render, focus });
}
