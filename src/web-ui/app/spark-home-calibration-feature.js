import { createSparkHomeCalibrationController } from "./controllers/spark-home-calibration-controller.js";
import { createSparkHomeCalibrationDialog } from "./components/spark-home/calibration-dialog.js";

/** Calibration reuses HOME settings and the existing hidden SPARK generation lifecycle. */
export function createSparkHomeCalibrationFeature({ client, settings, home, shell, getEnvironmentId, documentRoot }) {
  let controller;
  let view;
  async function saved({ requestScreen, environmentId }) {
    if (!requestScreen || environmentId !== getEnvironmentId()) return;
    if (shell.activeWorkspace() !== "home") {
      const activate = await shell.prepareWorkspaceActivation("home");
      if (!activate || environmentId !== getEnvironmentId()) return;
      if (!activate()) return;
    }
    await home.selectMode("spark");
    if (environmentId !== getEnvironmentId()) return;
    await home.refresh();
    if (environmentId !== getEnvironmentId()) return;
    await home.requestNewScreen({ confirmed: true });
  }
  controller = createSparkHomeCalibrationController({ client, settings, getEnvironmentId,
    onRequest: () => home.requestNewScreen(), onSaved: saved,
    render(state) {
      if (!view && !state.open) return;
      view ??= createSparkHomeCalibrationDialog({ documentRoot,
        onChange: (name, value) => controller.change(name, value), onDraft: () => controller.draft(),
        onSave: (requestScreen) => controller.save(requestScreen), onClose: () => controller.close(),
      });
      view.render(state);
    },
  });
  return controller;
}
