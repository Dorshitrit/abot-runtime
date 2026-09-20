import type { RuntimeSetupActivation } from "./runtime-setup-input.js";
import type { RuntimeSetupRoutes } from "./runtime-setup-routes.js";

/** Close only the draft that was present when applying started. */
export async function applyAndCompleteRuntimeSetup(
  setup: RuntimeSetupRoutes,
  apply: () => Promise<RuntimeSetupActivation>,
): Promise<RuntimeSetupActivation> {
  const snapshot = await setup.status();
  const revision = snapshot.editableConnection?.revision;
  const activation = await apply();
  if (activation.status !== "ready" || !revision) return activation;
  if (await setup.finalize(revision)) return activation;
  return {
    status: "restart_required",
    message:
      "Your connection changed while setup was being applied. Review the current settings and apply again.",
  };
}

export async function pendingRuntimeSetupCatalog(setup: RuntimeSetupRoutes) {
  const snapshot = await setup.status();
  if (!snapshot.editableConnection) return null;
  return {
    profiles: [],
    modes: [],
    availability: {
      status: "setup_required",
      code: "runtime_configuration_required",
      message: "Continue setup to review and apply your saved connection.",
    },
  };
}
