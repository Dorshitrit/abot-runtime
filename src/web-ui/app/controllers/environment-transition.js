/** Owns the active window environment. Its saved default is an independent preference. */
export function createEnvironmentTransition({ state, dom, actions, prepareQueueRecovery, onNavigationChange, onFailure = () => {} }) {
  let revision = 0;
  let changing = false;
  let notifying = false;
  let prepareAdditional = () => true;
  let refreshAdditional = () => {};
  function refreshSubmissionState() {
    actions.refreshComposerSubmissionState?.();
    refreshAdditional();
  }
  let committedEnvironment = dom.environmentSelect.value;

  function notifySubscribers() {
    const ChangeEvent = dom.environmentSelect.ownerDocument?.defaultView?.Event ?? Event;
    notifying = true;
    try { dom.environmentSelect.dispatchEvent(new ChangeEvent("change")); }
    finally { notifying = false; }
  }

  function hasCurrentEnvironmentSelection(operation, target) {
    if (operation !== revision) return false;
    return dom.environmentSelect.value === target;
  }

  async function changeEnvironment(target, { restoreSession = true, notifyEnvironmentChange = true, commitEnvironmentOptions } = {}) {
    const operation = ++revision;
    const previous = committedEnvironment;
    let committed = false;
    const restoreSelection = () => {
      dom.environmentSelect.value = previous;
      state.agentPickerOpen = false;
      actions.renderAgentPicker();
    };
    changing = true;
    state.environmentChangePending = true;
    try {
      // Consumers read the selector, so expose only the committed environment.
      dom.environmentSelect.value = previous;
      refreshSubmissionState();
      if (target === previous) { restoreSelection(); return true; }
      let preparedAdditional = prepareAdditional();
      if (isPendingPreparation(preparedAdditional)) {
        preparedAdditional = await preparedAdditional;
      }
      if (!hasCurrentEnvironmentSelection(operation, previous)) return false;
      if (environmentChangeWasDeclined(preparedAdditional)) { restoreSelection(); return false; }
      let preparedQueue = prepareQueueRecovery();
      if (isPendingPreparation(preparedQueue)) {
        preparedQueue = await preparedQueue;
      }
      if (!hasCurrentEnvironmentSelection(operation, previous)) return false;
      if (environmentChangeWasDeclined(preparedQueue)) { restoreSelection(); return false; }
      if (!canCommitEnvironmentPreparations([preparedAdditional, preparedQueue, commitEnvironmentOptions])) { restoreSelection(); return false; }
      const preparedConfig = actions.beforeEnvironmentChange
        ? await actions.beforeEnvironmentChange({ from: previous, to: target }) : true;
      if (!hasCurrentEnvironmentSelection(operation, previous)) return false;
      if (environmentChangeWasDeclined(preparedConfig)) { restoreSelection(); return false; }
      if (!canCommitEnvironmentPreparations([preparedAdditional, preparedQueue, preparedConfig, commitEnvironmentOptions])) { restoreSelection(); return false; }
      if (typeof preparedAdditional === "function") preparedAdditional();
      if (typeof preparedQueue === "function") preparedQueue();
      if (typeof preparedConfig === "function") preparedConfig();
      commitEnvironmentOptions?.();
      actions.invalidateSessionLoads?.();
      committedEnvironment = target;
      dom.environmentSelect.value = target;
      committed = true;
      state.agentPickerOpen = false;
      actions.renderAgentPicker();
      state.environmentChangePending = false;
      state.currentSessionId = "";
      state.messages = [];
      actions.resetLiveRequestView();
      dom.sessionTitle.textContent = "New conversation";
      actions.applyConversationChrome();
      actions.renderMessages();
      // Persistence errors are visible but never roll back an already committed route.
      try { void Promise.resolve(actions.saveEnvironmentId(target)).catch(onFailure); }
      catch (error) { onFailure(error); }
      const loading = Promise.allSettled([
        actions.loadModels(), actions.loadAgentMode(),
        actions.loadRuntimeConfig({ protectUnsaved: false, clearBeforeLoad: true }),
      ]);
      if (notifyEnvironmentChange) notifySubscribers();
      await loading;
      if (!hasCurrentEnvironmentSelection(operation, target)) return false;
      if (restoreSession) await actions.restoreLastSession();
      return hasCurrentEnvironmentSelection(operation, target);
    } catch (error) {
      const currentEnvironment = committed ? target : previous;
      if (!hasCurrentEnvironmentSelection(operation, currentEnvironment)) return false;
      if (!committed) restoreSelection();
      onFailure(error);
      return committed;
    } finally {
      if (operation === revision) {
        changing = false;
        state.environmentChangePending = false;
        refreshSubmissionState();
        onNavigationChange();
      }
    }
  }

  function onSelectChange(event) {
    if (notifying) return;
    const target = dom.environmentSelect.value;
    // The transition emits one event when the environment actually commits.
    event.stopImmediatePropagation();
    void changeEnvironment(target);
  }

  return {
    changeEnvironment, onSelectChange,
    initializeEnvironment: () => { committedEnvironment = dom.environmentSelect.value; },
    setEnvironmentChangePreparation: (prepare, refresh = () => {}) => { prepareAdditional = prepare; refreshAdditional = refresh; },
    isEnvironmentChanging: () => changing,
  };
}

function isPendingPreparation(value) { return typeof value?.then === "function"; }
export function environmentChangeWasDeclined(value) { return value === false || value === null; }

function canCommitEnvironmentPreparations(preparations) {
  return preparations.every((prepared) => prepared?.canCommit?.() !== false);
}
