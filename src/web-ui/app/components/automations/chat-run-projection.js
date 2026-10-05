import { createEventRefresh } from "../../lib/event-refresh.js";
import { createAutomationLiveView } from "./live-view.js";
import { renderAutomationRun } from "./run.js";
import { focusSelectedAutomationStep } from "./run-steps-view.js";
import { selectedAutomationRunStepId } from "./run-step-selection.js";

function errorText(error) {
  const code = typeof error?.code === "string" ? `${error.code} · ` : "";
  return `${code}${error instanceof Error ? error.message : String(error)}`;
}

function isRunChange(message, environmentId, runId) {
  if (message?.type !== "event" || message.environment !== environmentId) return false;
  if (typeof message.name !== "string" || !message.name.startsWith("automation.")) return false;
  return typeof message.runId !== "string" || !message.runId || message.runId === runId;
}

function hasSelectedStepEvidence(response, runId, nodeId) {
  return response?.evidence?.runId === runId && response.evidence.nodeId === nodeId;
}

export function createAutomationChatRunProjection({
  dom, client, getEnvironmentId, onNavigationChange, returnToStudio,
  isVisible = () => document.visibilityState !== "hidden",
}) {
  const liveView = createAutomationLiveView(dom.automationChatRunPanel);
  let runId = "";
  let run = null;
  let error = "";
  let loading = false;
  let selectedNodeId = "";
  let stepEvidence = null;
  let stepEvidenceLoading = false;
  let stepEvidenceError = "";
  let fullEvidenceRequested = false;
  let evidenceRevision = 0;
  let chatActive = false;
  let readRevision = 0;
  let pendingWhileBusy = false;
  let activeBackgroundReads = 0;

  function resumePendingRefresh() {
    if (!pendingWhileBusy || loading || stepEvidenceLoading) return;
    pendingWhileBusy = false;
    eventRefresh.schedule();
  }

  function render() {
    const showing = chatActive && Boolean(runId);
    dom.app.classList.toggle("automation-run-chat", showing);
    dom.automationChatRunPanel.hidden = !showing;
    dom.automationChatRunPanel.inert = !showing;
    if (chatActive) {
      dom.chatPanel.hidden = showing;
      dom.chatPanel.inert = showing || dom.app.classList.contains("sessions-open");
      const sessionsVisible = !showing &&
        (dom.app.classList.contains("sessions-docked") || dom.app.classList.contains("sessions-open"));
      dom.sessionsPanel.hidden = !sessionsVisible;
      dom.sessionsPanel.inert = !sessionsVisible;
      dom.sessionsToggleButton.hidden = showing || dom.app.classList.contains("sessions-docked");
    }
    if (!showing) {
      liveView.clear();
      return;
    }
    dom.automationChatRunPanel.setAttribute("aria-busy", String(loading));
    liveView.update(runId, renderAutomationRun({
      automations: [], selectedAutomationId: run?.automationId || "",
      selectedRunId: runId, selectedNodeId, runs: [], run, error,
      stepEvidence, stepEvidenceLoading, stepEvidenceError,
      feedback: loading ? "Loading saved run…" : "",
    }, { locked: true }));
  }

  function clear({ notify = true } = {}) {
    if (!runId) return;
    readRevision += 1;
    runId = "";
    run = null;
    error = "";
    loading = false;
    selectedNodeId = "";
    evidenceRevision += 1;
    stepEvidence = null;
    stepEvidenceLoading = false;
    stepEvidenceError = "";
    fullEvidenceRequested = false;
    pendingWhileBusy = false;
    eventRefresh.cancel();
    render();
    if (notify) onNavigationChange();
  }

  function matchesRead(selected, environmentId, revision) {
    return revision === readRevision && selected === runId &&
      environmentId === getEnvironmentId();
  }

  function matchesEvidence(selected, environmentId, revision, nodeId, evidenceRead) {
    return matchesRead(selected, environmentId, revision) &&
      nodeId === selectedNodeId && evidenceRead === evidenceRevision;
  }

  function loadInitialRun(loadedRun) {
    run = loadedRun;
    selectedNodeId = selectedAutomationRunStepId(run, selectedNodeId);
    error = "";
    loading = false;
    if (selectedNodeId) return loadStepEvidence(run.id, selectedNodeId, fullEvidenceRequested);
    render();
    resumePendingRefresh();
    return true;
  }

  async function reload({ background = false } = {}) {
    if (!runId) return false;
    const selected = runId;
    const environmentId = getEnvironmentId();
    const revision = ++readRevision;
    const nodeId = selectedNodeId;
    const full = fullEvidenceRequested;
    const evidenceRead = ++evidenceRevision;
    const isInitialRunRead = !run;
    if (background) activeBackgroundReads += 1;
    if (!background && !run) {
      loading = true;
      error = "";
      render();
    }
    try {
      const response = await client.getAutomationRun(selected, environmentId);
      if (!matchesRead(selected, environmentId, revision)) return false;
      if (!response?.run || response.run.id !== selected)
        throw new Error("The selected automation run is unavailable.");
      if (isInitialRunRead) return await loadInitialRun(response.run);
      const evidenceNodeId = selectedAutomationRunStepId(response.run, nodeId);
      let evidenceResponse = null;
      if (evidenceNodeId) {
        evidenceResponse = await client.getAutomationStepEvidence(
          selected, evidenceNodeId, environmentId, full,
        );
      }
      if (!matchesEvidence(selected, environmentId, revision, nodeId, evidenceRead)) return false;
      if (evidenceNodeId && !hasSelectedStepEvidence(evidenceResponse, selected, evidenceNodeId))
        throw new Error("The selected step evidence is unavailable.");
      run = response.run;
      selectedNodeId = evidenceNodeId;
      stepEvidence = evidenceNodeId ? evidenceResponse.evidence : null;
      stepEvidenceLoading = false;
      stepEvidenceError = "";
      error = "";
      loading = false;
      render();
      resumePendingRefresh();
      return true;
    } catch (cause) {
      if (!matchesEvidence(selected, environmentId, revision, nodeId, evidenceRead)) return false;
      error = errorText(cause);
      loading = false;
      stepEvidenceLoading = false;
      render();
      resumePendingRefresh();
      return false;
    } finally {
      if (background) activeBackgroundReads -= 1;
    }
  }

  async function loadStepEvidence(selectedRunId, nodeId, full = false) {
    const revision = ++evidenceRevision;
    const read = readRevision;
    const environmentId = getEnvironmentId();
    if (activeBackgroundReads > 0) pendingWhileBusy = true;
    if (stepEvidence?.runId !== selectedRunId || stepEvidence.nodeId !== nodeId)
      stepEvidence = null;
    stepEvidenceError = "";
    stepEvidenceLoading = true;
    render();
    try {
      const response = await client.getAutomationStepEvidence(selectedRunId, nodeId, environmentId, full);
      if (!matchesEvidence(selectedRunId, environmentId, read, nodeId, revision)) return false;
      if (!hasSelectedStepEvidence(response, selectedRunId, nodeId))
        throw new Error("The selected step evidence is unavailable.");
      stepEvidence = response.evidence;
      return true;
    } catch (cause) {
      if (matchesEvidence(selectedRunId, environmentId, read, nodeId, revision))
        stepEvidenceError = errorText(cause);
      return false;
    } finally {
      if (matchesEvidence(selectedRunId, environmentId, read, nodeId, revision)) {
        stepEvidenceLoading = false;
        render();
        resumePendingRefresh();
      }
    }
  }

  async function open(selected) {
    if (!selected) { clear(); return true; }
    if (selected !== runId) {
      eventRefresh.cancel();
      runId = selected;
      run = null;
      error = "";
      loading = false;
      selectedNodeId = "";
      evidenceRevision += 1;
      stepEvidence = null;
      stepEvidenceLoading = false;
      stepEvidenceError = "";
      fullEvidenceRequested = false;
      pendingWhileBusy = false;
      liveView.clear();
      onNavigationChange();
    }
    return reload();
  }

  async function stop() {
    if (!run || !["pending", "running"].includes(run.status)) return;
    const selected = runId;
    const environmentId = getEnvironmentId();
    try {
      await client.stopAutomationRun(selected, environmentId);
      if (selected === runId && environmentId === getEnvironmentId())
        await reload({ background: true });
    } catch (cause) {
      if (selected !== runId || environmentId !== getEnvironmentId()) return;
      error = errorText(cause);
      render();
    }
  }

  dom.automationChatRunPanel.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.action === "stop") void stop();
    if (button.dataset.action === "return-studio") returnToStudio(run);
    if (button.dataset.action === "show-full-step-output" && selectedNodeId) {
      fullEvidenceRequested = true;
      void loadStepEvidence(runId, selectedNodeId, true);
    }
    if (button.dataset.automationNode !== undefined) {
      selectedNodeId = button.dataset.automationNode;
      evidenceRevision += 1;
      stepEvidence = null;
      stepEvidenceLoading = false;
      stepEvidenceError = "";
      fullEvidenceRequested = false;
      if (selectedNodeId) void loadStepEvidence(runId, selectedNodeId);
      else render();
      focusSelectedAutomationStep(dom.automationChatRunPanel);
    }
  });
  const eventRefresh = createEventRefresh({
    canRefresh: () => chatActive && Boolean(runId) && isVisible(),
    refresh: () => {
      if (loading || stepEvidenceLoading) {
        pendingWhileBusy = true;
        return false;
      }
      return reload({ background: true });
    },
  });
  render();
  return {
    open, clear, runId: () => runId,
    workspaceChanged(workspace) {
      chatActive = workspace === "chat";
      if (!chatActive) clear({ notify: false });
      render();
    },
    handleRealtime(message) {
      if (isRunChange(message, getEnvironmentId(), runId)) eventRefresh.schedule();
    },
    reconnect: () => eventRefresh.schedule(),
    visibilityChanged: () => eventRefresh.schedule(),
  };
}
