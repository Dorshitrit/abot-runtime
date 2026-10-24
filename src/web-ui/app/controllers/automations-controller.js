import { createEventRefresh } from "../lib/event-refresh.js";
import { findAutomationNode } from "../components/automations/timeline.js";
import { selectedAutomationRunStepId } from "../components/automations/run-step-selection.js";
import { createAutomationMutationRunner } from "./automation-mutation-lifecycle.js";
import { createAutomationDraftActions } from "./automation-draft-actions.js";
import { createAutomationRunActions } from "./automation-run-actions.js";
import { createAutomationViewCapture } from "./automation-view-scope.js";
import { createAutomationManagementActions } from "./automation-management-actions.js";
import { createAutomationRunHistory } from "./automation-run-history.js";
import {
  automationProjectionChanged, readAutomationBackgroundProjection,
  readAutomationList, readAutomationSelection, validationResult,
} from "./automation-read-projection.js";

function errorLabel(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  const message = error instanceof Error ? error.message : String(error);
  return code ? `${code} · ${message}` : message;
}

function isAutomationChange(message) {
  if (message?.type === "event")
    return typeof message.name === "string" &&
      (message.name.startsWith("automation.") || message.name === "scheduler.changed");
  return message?.type === "workspace_changed" &&
    Array.isArray(message.resources) && message.resources.includes("automations");
}

export function createAutomationsController({
  client, getEnvironmentId, render, onNavigationChange = () => {},
  isVisible = () => globalThis.document?.visibilityState !== "hidden",
  isEditingDirty = () => false,
}) {
  const state = {
    automations: [], selectedAutomationId: "", selectedRunId: "", selectedNodeId: "", lastViewedRunId: "",
    draft: null, publishedDefinition: null, grant: null, validation: null, validationVisible: false,
    catalog: null, templateCatalog: null, templateCatalogError: "", runs: [], run: null,
    loading: false, mutation: "", error: "", feedback: "",
    stepEvidence: null, stepEvidenceLoading: false, stepEvidenceError: "",
  };
  let active = false;
  let loaded = false;
  let navigationRevision = 0;
  let readRevision = 0;
  let navigationRequestRevision = 0;
  let evidenceReadRevision = 0;
  let mutationRevision = 0;
  let stepEvidenceFull = false;
  let draftActions;
  let runActions;
  const snapshot = () => ({ ...state, draftUndo: draftActions?.undoState() || null,
    runStartPending: runActions?.isStartingRun() || false });
  const publish = () => render(snapshot());
  const runHistory = createAutomationRunHistory({ state, client, getEnvironmentId, publish, errorLabel });
  const { setRunFilters, loadMoreRuns, resetRunHistory, retryRunHistory } = runHistory;
  const currentEnvironment = (environmentId) => environmentId === getEnvironmentId();
  const captureView = createAutomationViewCapture({ state, getEnvironmentId,
    getNavigationRevision: () => navigationRevision, getNavigationRequestRevision: () => navigationRequestRevision,
    getMutationRevision: () => mutationRevision });
  const mutation = createAutomationMutationRunner({ state, publish, errorLabel,
    captureCurrentView: () => captureView().isCurrent,
    onStart: () => { mutationRevision += 1; } });
  draftActions = createAutomationDraftActions({ state, client, mutation, publish, loadList,
    currentEnvironment, captureView });
  const { mutateDraft, saveDefinition, saveNode, undoDraftMove, restorePublishedDraft } = draftActions;
  runActions = createAutomationRunActions({ client, mutation, publish,
    loadSelected, openRun, captureView,
    refreshRunHistory: (isCurrent) => runHistory.resetRunHistory({ isCurrent, supersede: true }) });
  const { startRun, stopRun, rerun } = runActions;
  const { create, deleteDraft, publishDefinition, setActive, changeArchiveState, setPermission } =
    createAutomationManagementActions({ state, client, mutation, captureView,
      loadList, loadSelected, refresh, openRoute });
  const eventRefresh = createEventRefresh({
    canRefresh: () => active && loaded && isVisible() && !state.loading &&
      !state.stepEvidenceLoading && !state.mutation && !isEditingDirty(),
    refresh: () => backgroundRefresh(),
  });

  function selectIdentity(automationId, runId = "") {
    if (state.selectedAutomationId === automationId && state.selectedRunId === runId) return;
    eventRefresh.cancel();
    const automationChanged = state.selectedAutomationId !== automationId;
    state.selectedAutomationId = automationId;
    state.selectedRunId = runId;
    state.selectedNodeId = "";
    state.run = null;
    evidenceReadRevision += 1;
    stepEvidenceFull = false;
    state.stepEvidence = null;
    state.stepEvidenceLoading = false;
    state.stepEvidenceError = "";
    if (automationChanged) {
      state.lastViewedRunId = "";
      state.draft = null;
      state.publishedDefinition = null;
      state.grant = null;
      state.validation = null;
      state.validationVisible = false;
      state.catalog = null;
      runHistory.resetScope();
    }
    if (runId) state.lastViewedRunId = runId;
    navigationRevision += 1;
    onNavigationChange();
  }

  async function loadList(isCurrent = () => true) {
    if (!isCurrent()) return false;
    const environmentId = getEnvironmentId();
    const revision = ++readRevision;
    state.loading = true;
    state.error = "";
    publish();
    try {
      const projection = await readAutomationList(client, environmentId);
      if (!isCurrent()) return false;
      if (revision !== readRevision || !currentEnvironment(environmentId)) return false;
      Object.assign(state, projection);
      loaded = true;
      return true;
    } catch (error) {
      if (revision === readRevision && currentEnvironment(environmentId) && isCurrent()) state.error = errorLabel(error);
      return false;
    } finally {
      if (revision === readRevision) {
        state.loading = false;
        publish();
      }
    }
  }

  async function loadSelected(automationId, runId = "", isCurrent = () => true, refreshRuns = false) {
    if (!isCurrent()) return false;
    const environmentId = getEnvironmentId();
    const revision = ++readRevision;
    const historyRead = runHistory.captureRead({ refresh: refreshRuns });
    state.loading = true;
    state.error = "";
    publish();
    try {
      const projection = await readAutomationSelection(client, automationId, runId, environmentId,
        { runsQuery: historyRead.query });
      if (!isCurrent()) return false;
      if (revision !== readRevision || !currentEnvironment(environmentId)) return false;
      if (state.selectedAutomationId !== automationId) return false;
      const { runs, runsNextCursor, ...selection } = projection;
      Object.assign(state, selection);
      historyRead.accept({ runs, runsNextCursor });
      const selectedNodeId = selectedAutomationRunStepId(state.run, state.selectedNodeId);
      const initialStepSelected = selectedNodeId !== state.selectedNodeId;
      state.selectedNodeId = selectedNodeId;
      if (initialStepSelected) await loadStepEvidence(runId, selectedNodeId, false, isCurrent);
      return true;
    } catch (error) {
      if (revision === readRevision && currentEnvironment(environmentId) && isCurrent()) state.error = errorLabel(error);
      return false;
    } finally {
      if (revision === readRevision) {
        state.loading = false;
        publish();
      }
    }
  }

  async function openRoute(automationId = "", runId = "", ownsMutation = () => true) {
    if (!ownsMutation()) return false;
    const revision = ++navigationRequestRevision;
    const environmentId = getEnvironmentId();
    const isCurrentRoute = () => revision === navigationRequestRevision &&
      currentEnvironment(environmentId) && ownsMutation();
    if (!client.supportsAutomations()) return false;
    if (!loaded || !automationId) await loadList(isCurrentRoute);
    if (!isCurrentRoute()) return false;
    selectIdentity(automationId, runId);
    if (!automationId) {
      state.draft = null;
      state.publishedDefinition = null;
      state.run = null;
      state.catalog = null;
      state.runs = [];
      publish();
      return true;
    }
    return loadSelected(automationId, runId, isCurrentRoute);
  }

  async function refresh(isCurrent = captureView().captureContinuation().isCurrent) {
    if (!isCurrent()) return false;
    const selected = state.selectedAutomationId;
    const runId = state.selectedRunId;
    const loadedList = await loadList(isCurrent);
    if (!loadedList || !isCurrent()) return false;
    if (!selected) return true;
    const selectedLoaded = await loadSelected(selected, runId, isCurrent, true);
    if (!selectedLoaded || !isCurrent()) return false;
    if (selectedLoaded && runId && state.selectedNodeId)
      await loadStepEvidence(runId, state.selectedNodeId, stepEvidenceFull, isCurrent);
    return isCurrent();
  }

  function backgroundIdentityMatches(identity) {
    if (!active || !loaded || !isVisible() || state.loading || state.stepEvidenceLoading ||
        state.mutation || isEditingDirty()) return false;
    if (!currentEnvironment(identity.environmentId) || identity.readRevision !== readRevision ||
        identity.navigationRevision !== navigationRevision || identity.mutationRevision !== mutationRevision ||
        identity.evidenceRevision !== evidenceReadRevision ||
        identity.historyRevision !== runHistory.revision()) return false;
    return state.selectedAutomationId === identity.automationId &&
      state.selectedRunId === identity.runId && state.selectedNodeId === identity.nodeId;
  }

  async function backgroundRefresh() {
    const historyRead = runHistory.captureRead({ refresh: true });
    const identity = {
      environmentId: getEnvironmentId(), automationId: state.selectedAutomationId,
      runId: state.selectedRunId, nodeId: state.selectedNodeId,
      readRevision, navigationRevision, mutationRevision,
      evidenceRevision: evidenceReadRevision, full: stepEvidenceFull,
      runsQuery: historyRead.query, historyRevision: runHistory.revision(),
    };
    if (!backgroundIdentityMatches(identity)) return false;
    try {
      const projection = await readAutomationBackgroundProjection(client, identity);
      if (!backgroundIdentityMatches(identity)) return false;
      if (!automationProjectionChanged(state, projection)) return true;
      const { runs, runsNextCursor, ...selection } = projection;
      Object.assign(state, selection);
      historyRead.accept({ runs, runsNextCursor });
      publish();
      return true;
    } catch {
      // A background read leaves the visible state intact; explicit reads surface errors.
      return false;
    }
  }

  async function loadStepEvidence(runId, nodeId, full = false, isCurrent = () => true) {
    if (!isCurrent()) return false;
    const revision = ++evidenceReadRevision;
    if (full) stepEvidenceFull = true;
    const environmentId = getEnvironmentId();
    if (state.stepEvidence?.runId !== runId || state.stepEvidence?.nodeId !== nodeId)
      state.stepEvidence = null;
    state.stepEvidenceError = "";
    state.stepEvidenceLoading = true;
    publish();
    try {
      const response = await client.getAutomationStepEvidence(runId, nodeId, environmentId, full);
      if (!isCurrent()) return false;
      if (revision !== evidenceReadRevision || !currentEnvironment(environmentId) ||
          state.selectedRunId !== runId || state.selectedNodeId !== nodeId) return false;
      if (response?.evidence?.runId !== runId || response.evidence.nodeId !== nodeId)
        throw new Error("The selected step evidence is unavailable.");
      state.stepEvidence = response.evidence;
      return true;
    } catch (error) {
      if (revision === evidenceReadRevision && currentEnvironment(environmentId) && isCurrent())
        state.stepEvidenceError = errorLabel(error);
      return false;
    } finally {
      if (revision === evidenceReadRevision) {
        state.stepEvidenceLoading = false;
        publish();
      }
    }
  }

  async function saveAgent() {
    const view = captureView();
    const automationId = state.selectedAutomationId;
    const node = findAutomationNode(state.draft?.definition?.body, state.selectedNodeId);
    const expectedRevision = state.draft?.revision;
    const environmentId = getEnvironmentId();
    const identityRevision = navigationRevision;
    let savedAgentMutationRevision = mutationRevision;
    if (!automationId || node?.kind !== "agent" || !Number.isInteger(expectedRevision)) return false;
    function isCurrentSavedAgentMutation() {
      if (!view.isCurrent()) return false;
      if (!currentEnvironment(environmentId)) return false;
      if (identityRevision !== navigationRevision) return false;
      if (savedAgentMutationRevision !== mutationRevision) return false;
      return state.selectedAutomationId === automationId;
    }
    const result = await mutation("Agent template", () => {
      savedAgentMutationRevision = mutationRevision;
      return client.saveAutomationAgent(automationId, node.id, expectedRevision, environmentId);
    }, "", isCurrentSavedAgentMutation);
    if (!result?.agent?.agentId || !isCurrentSavedAgentMutation()) return false;
    try {
      const catalog = await client.getAutomationCatalog(automationId, environmentId);
      if (!isCurrentSavedAgentMutation()) return false;
      state.catalog = catalog;
    } catch (error) {
      if (!isCurrentSavedAgentMutation()) return false;
      state.error = `Agent saved, but the palette could not refresh: ${errorLabel(error)}`;
    }
    state.feedback = `Saved agent · revision ${result.agent.revision}.`;
    publish();
    return true;
  }

  async function validate() {
    const automationId = state.selectedAutomationId, environmentId = getEnvironmentId();
    const identityRevision = navigationRevision, draftRevision = state.draft?.revision;
    if (!automationId) return false;
    const isCurrentValidation = () => currentEnvironment(environmentId) &&
      identityRevision === navigationRevision && state.selectedAutomationId === automationId &&
      state.draft?.revision === draftRevision;
    const response = await mutation("Validation", () =>
      client.validateAutomation(automationId, environmentId), "", isCurrentValidation);
    if (!response || !isCurrentValidation()) return false;
    state.validation = validationResult(response.validation || response);
    state.validationVisible = true;
    state.feedback = state.validation?.issues?.length
      ? "Review the items below before publishing." : "Check complete. Ready to publish.";
    publish();
    return true;
  }

  async function openRun(runId, ownsMutation = () => true) {
    if (!ownsMutation()) return false;
    const revision = ++navigationRequestRevision;
    const automationId = state.selectedAutomationId;
    const environmentId = getEnvironmentId();
    const identityRevision = navigationRevision;
    try {
      const response = await client.getAutomationRun(runId, environmentId);
      if (!ownsMutation()) return false;
      if (revision !== navigationRequestRevision || identityRevision !== navigationRevision ||
          automationId !== state.selectedAutomationId ||
          !currentEnvironment(environmentId)) return false;
      if (!response?.run) return false;
      if (response.run.automationId !== automationId)
        throw new Error("This run belongs to another automation.");
      selectIdentity(automationId, runId);
      state.run = response.run;
      state.selectedNodeId = selectedAutomationRunStepId(state.run, state.selectedNodeId);
      publish();
      if (state.selectedNodeId) void loadStepEvidence(runId, state.selectedNodeId);
      return true;
    } catch (error) {
      if (!ownsMutation()) return false;
      if (revision !== navigationRequestRevision || identityRevision !== navigationRevision ||
          automationId !== state.selectedAutomationId ||
          !currentEnvironment(environmentId)) return false;
      state.error = errorLabel(error);
      publish();
      return false;
    }
  }

  function environmentChanged() {
    eventRefresh.cancel();
    draftActions.clearUndo();
    readRevision += 1;
    loaded = false;
    runHistory.resetScope();
    stepEvidenceFull = false;
    Object.assign(state, {
      automations: [], selectedAutomationId: "", selectedRunId: "", selectedNodeId: "", lastViewedRunId: "",
      draft: null, publishedDefinition: null, grant: null, validation: null, validationVisible: false,
      catalog: null, templateCatalog: null, templateCatalogError: "", runs: [], run: null,
      loading: false, error: "", feedback: "",
      stepEvidence: null, stepEvidenceLoading: false, stepEvidenceError: "",
    });
    evidenceReadRevision += 1;
    navigationRevision += 1;
    publish();
    if (active) void loadList();
  }

  function setWorkspaceActive(value) {
    active = value;
    if (active && !loaded) void loadList();
  }

  function handleRealtime(message) {
    if (!isAutomationChange(message)) return;
    if (message.environment !== getEnvironmentId()) return;
    eventRefresh.schedule();
  }

  function captureActionScope() {
    const continuation = captureView().captureContinuation();
    const draftRevision = state.draft?.revision;
    const publishedRevision = state.publishedDefinition?.revision;
    return () => continuation.isCurrent() && draftRevision === state.draft?.revision &&
      publishedRevision === state.publishedDefinition?.revision;
  }

  return {
    snapshot, openRoute, refresh, create, captureActionScope,
    createTemplate: (templateId) => create(templateId), deleteDraft, mutateDraft, saveDefinition,
    saveNode, saveAgent, validate, publishDefinition, setActive, undoDraftMove, restorePublishedDraft,
    archive: () => changeArchiveState(true), restore: () => changeArchiveState(false),
    setPermission, openRun, setRunFilters, loadMoreRuns, resetRunHistory, retryRunHistory,
    startRun, stopRun, rerun, environmentChanged, setWorkspaceActive, handleRealtime,
    showFullStepOutput() {
      if (!state.selectedRunId || !state.selectedNodeId) return false;
      return loadStepEvidence(state.selectedRunId, state.selectedNodeId, true);
    },
    reconnect: () => { if (active) eventRefresh.schedule(); },
    visibilityChanged: () => { if (active && isVisible()) eventRefresh.schedule(); },
    selectNode(nodeId) {
      eventRefresh.cancel();
      evidenceReadRevision += 1;
      stepEvidenceFull = false;
      state.selectedNodeId = nodeId;
      state.stepEvidence = null;
      state.stepEvidenceError = "";
      state.stepEvidenceLoading = false;
      publish();
      if (nodeId && state.selectedRunId) void loadStepEvidence(state.selectedRunId, nodeId);
    },
    selectedAutomationId: () => state.selectedAutomationId,
    selectedRunId: () => state.selectedRunId,
    navigationRevision: () => navigationRevision,
  };
}
