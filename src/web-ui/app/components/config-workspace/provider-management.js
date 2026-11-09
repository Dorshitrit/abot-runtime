import { confirmDialog } from "../confirmation-dialog.js";
import { isConfigObject } from "./config-model.js";
import { configuredProviderConnections, providerUsage } from "./provider-connections.js";
import { promptProviderEdits } from "./provider-editor.js";

export function createProviderManagement({
  root, runtimeClient, getEnvironmentId, getWorkspace, onSaved,
  edit = promptProviderEdits, confirm = confirmDialog,
}) {
  let pending = false;

  async function savedAfterUncertainResponse(connection, edits, environment) {
    const response = await runtimeClient.loadConfigDashboard(environment, { settled: true });
    const runtime = response?.dashboard?.files?.runtime;
    if (!isConfigObject(runtime?.config?.models?.providers) || !runtime.revision) throw new Error("Provider settings unavailable.");
    const saved = configuredProviderConnections(runtime, []).find(({ id }) => id === connection.id);
    if (edits === null) return !saved;
    return saved?.type === connection.type && Object.entries(edits).every(([field, value]) => saved.settings[field] === value);
  }

  async function manage(action, connection) {
    const workspace = getWorkspace();
    const trigger = root?.ownerDocument?.activeElement;
    const restoreFocus = trigger?.dataset?.configAction === action && trigger.dataset.providerId === connection.id;
    if (pending || !workspace.beginExternalRuntimeMutation("provider settings")) return false;
    const environment = getEnvironmentId();
    const removing = action === "delete-provider";
    const verb = removing ? "deleted" : "updated";
    pending = true;
    try {
      if (!connection.expectedRevision) throw new Error("Refresh Models before changing this provider.");
      let edits = null;
      if (removing) {
        const usage = providerUsage(connection);
        if (usage) throw new Error(`To delete ${connection.id}, first reassign or remove its ${usage}.`);
        if (!await confirm(`Delete the saved provider connection “${connection.id}”?`, {
          title: "Delete provider", confirmLabel: "Delete provider", tone: "danger",
        })) return false;
      } else {
        edits = await edit(root, connection, (options) => runtimeClient.listChatgptAccounts(options));
        if (!edits) return false;
      }
      if (environment !== getEnvironmentId()) return false;
      const input = { providerId: connection.id, expectedRevision: connection.expectedRevision };
      try {
        if (removing) await runtimeClient.removeRuntimeProvider(input, environment);
        else await runtimeClient.updateRuntimeProvider({ ...input, ...edits }, environment);
      } catch (error) {
        if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) throw error;
        let saved;
        try { saved = await savedAfterUncertainResponse(connection, edits, environment); }
        catch { throw new Error("The provider change could not be confirmed. Refresh Models before trying again."); }
        if (!saved) throw error;
      }
      if (environment !== getEnvironmentId()) return true;
      onSaved();
      const prefix = `Provider ${connection.id} ${verb}; refresh required`;
      try {
        if (await workspace.refreshAfterExternalRuntimeMutation(prefix) && environment === getEnvironmentId())
          workspace.setStatus(`Provider ${connection.id} ${verb}. Apply changes when your agent is idle.`);
      } catch {
        if (environment === getEnvironmentId()) workspace.setStatus(prefix, "error-text");
      }
      return true;
    } catch (error) {
      if (environment === getEnvironmentId())
        workspace.setStatus(error instanceof Error ? error.message : "The provider change failed.", "error-text");
      return false;
    } finally {
      pending = false;
      workspace.endExternalRuntimeMutation();
      if (restoreFocus && getEnvironmentId() === environment) {
        const buttons = root.querySelectorAll("[data-provider-id]");
        const target = Array.from(buttons).find((button) => button.dataset.configAction === action && button.dataset.providerId === connection.id)
          || root.querySelector('[data-config-action="add-model"]');
        if (target && !target.closest("[hidden], [inert]")) target.focus({ preventScroll: true });
      }
    }
  }

  return { manage };
}
