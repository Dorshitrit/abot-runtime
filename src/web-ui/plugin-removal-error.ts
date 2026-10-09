import { ConfigFileConflictError } from "../runtime/adapters/config-file-transaction.js";
import { PluginManagementError } from "./plugin-management-service.js";
import type { RuntimeSetupActivation } from "./local-runtime/runtime-setup-input.js";

/** Keep confirmed activation evidence when the later file removal fails. */
export class PluginRemovalActivationError extends PluginManagementError {
  constructor(
    error: unknown,
    readonly activation: RuntimeSetupActivation,
  ) {
    const known =
      error instanceof PluginManagementError ||
      error instanceof ConfigFileConflictError;
    const status =
      error instanceof PluginManagementError ? error.statusCode : 500;
    super(
      known ? error.code : "plugin_removal_failed",
      known
        ? error.message
        : "Plugin removal could not complete. Refresh plugins before trying again.",
      error instanceof ConfigFileConflictError ? 409 : status,
    );
    this.cause = error;
  }
}
