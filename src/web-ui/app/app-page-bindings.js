import { bindRuntimeSetupPageLifecycle } from "./runtime-setup-page-lifecycle.js";

export function bindWebAppPageLifecycle({
  appEventBindings,
  page,
  documentRoot,
  environmentSelect,
  disposeRuntimeSetup,
  reloadModels,
  markSessionRead,
  environmentChanged,
  visibilityChanged,
}) {
  appEventBindings.bind();
  bindRuntimeSetupPageLifecycle({
    page,
    dispose: disposeRuntimeSetup,
    reloadModels,
  });
  documentRoot.addEventListener("visibilitychange", markSessionRead);
  documentRoot.addEventListener("visibilitychange", visibilityChanged);
  environmentSelect.addEventListener("change", environmentChanged);
}

export function bindWebAppWorkspaceLifecycle({
  appEventBindings, dom, runtimeSetupGuide, reloadModels, conversationSession,
  homeComposer, dashboardFeature, passiveLearning, notifications, operations,
}) {
  bindWebAppPageLifecycle({
    appEventBindings,
    page: window,
    documentRoot: document,
    environmentSelect: dom.environmentSelect,
    disposeRuntimeSetup: runtimeSetupGuide.dispose,
    reloadModels,
    markSessionRead: conversationSession.markCurrentSessionReadSoon,
    environmentChanged: () => {
      homeComposer.environmentChanged();
      dashboardFeature.environmentChanged();
      passiveLearning.environmentChanged();
      notifications.environmentChanged();
      operations.environmentChanged();
    },
    visibilityChanged: passiveLearning.visibilityChanged,
  });
}
