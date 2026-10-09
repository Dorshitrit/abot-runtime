import { PluginManagementError } from "../plugin-management-service.js";
import type { RuntimeEnvironment } from "./contracts.js";

/** A saved plugin change must not start while any owning Runtime is working. */
export function requirePluginOwnersIdle(options: {
  environments: Iterable<RuntimeEnvironment>;
  busy: boolean;
  unavailable: boolean;
}): void {
  if (options.unavailable)
    throw new PluginManagementError(
      "plugin_mutation_unavailable",
      "Apply Runtime configuration before changing plugins.",
      409,
    );
  if (options.busy) throw busyPluginMutation();
  for (const environment of options.environments) {
    if (environment.getOwnership() !== "owner")
      throw new PluginManagementError(
        "plugin_owner_unavailable",
        "This Web UI cannot verify that the owning Runtime is idle. Open Plugins in the Web UI that owns this Runtime.",
        409,
      );
    if (!environment.isOwnerIdle()) throw busyPluginMutation();
  }
}

function busyPluginMutation(): PluginManagementError {
  return new PluginManagementError(
    "plugin_runtime_busy",
    "Your agent is working. Wait for active conversations and Jobs to finish before changing plugins.",
    409,
  );
}
