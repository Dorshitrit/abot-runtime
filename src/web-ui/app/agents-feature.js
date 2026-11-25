import { createAgentsWorkspaceView } from "./components/agents/workspace-view.js";
import { createAgentsWorkspaceController } from "./components/agents/workspace-controller.js";
import { workspaceStorage } from "./services/workspace-state.js";
export function createAgentsFeature({ dom, client, shell, getEnvironmentId, onNavigationChange }) {
  const root = dom.agentsWorkspacePanel;
  if (!root) return { refreshAvailability() {}, environmentChanged() {}, selectedId: () => "", openRoute: async () => false };
  const view = createAgentsWorkspaceView({ root });
  const controller = createAgentsWorkspaceController({ client, view, getEnvironmentId, storage: workspaceStorage(), onNavigationChange,
    onHome: () => void shell.activateWorkspace("home") });
  controller.bind();
  const entry = dom.agentsWorkspaceButton;
  entry?.addEventListener("click", () => void shell.activateWorkspace("agents"));
  shell.subscribeWorkspaceChange((workspace) => controller.setActive(workspace === "agents"));
  dom.environmentSelect?.addEventListener("change", () => void controller.environmentChanged());
  shell.subscribeRuntimeAvailabilityChange?.(() => controller.setActive(shell.activeWorkspace() === "agents"));
  return {
    ...controller,
    refreshAvailability() {
      const enabled = client.supportsAgents?.() === true;
      if (entry) entry.hidden = !enabled;
      if (dom.agentsWorkspaceButton) { dom.agentsWorkspaceButton.disabled = !enabled; dom.agentsWorkspaceButton.title = enabled ? "Agents" : "Agents require the local Runtime backend"; }
    },
  };
}
