import { createStepTimeoutNotice } from "./components/step-timeout-notice.js";
import { createStepTimeoutController } from "./controllers/step-timeout-controller.js";
import { isContextReplayCurrent } from "./lib/context-window-replay.js";

export function createStepTimeoutFeature({ state, client, shell, getEnvironmentId, onApplied }) {
  const notice = createStepTimeoutNotice({
    onIncrease: () => controller.increase(),
    onDismiss: () => controller.dismiss(),
    onSettings: () => shell.activateWorkspace("models"),
  });
  const controller = createStepTimeoutController({
    client, onApplied,
    isReplayCurrent: (binding) => isContextReplayCurrent(binding, state, getEnvironmentId()),
    getScope: () => ({
      backend: state.config?.backend,
      workspace: shell.activeWorkspace(),
      environment: getEnvironmentId(),
      sessionId: state.currentSessionId,
      viewVersion: state.sessionViewVersion,
    }),
    render: notice.render,
  });
  shell.subscribeWorkspaceChange(controller.syncScope);
  return { syncScope: controller.syncScope, handleEvent: controller.handle };
}
