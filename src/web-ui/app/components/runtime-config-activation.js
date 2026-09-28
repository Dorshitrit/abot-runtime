/** Explicit application of saved files; presentation never stops an owner itself. */
export function createRuntimeConfigActivation({
  root,
  getWorkspace,
  apply,
  refresh,
  getEnvironmentId,
  onAppliedSettled = () => true,
}) {
  if (!root?.ownerDocument) return { markPending() {}, markApplied() {} };
  const panel = root.ownerDocument.createElement("section");
  panel.className = "runtime-config-activation";
  panel.setAttribute("aria-label", "Restart runtime with saved configuration");
  panel.innerHTML =
    '<p role="status" aria-live="polite">Restart with saved settings across environments when idle.</p><button type="button">Restart runtime</button>';
  const status = panel.querySelector("p");
  const button = panel.querySelector("button");
  root.append(panel);
  let busy = false;

  function markPending() {
    status.textContent = "Changes saved. Restart to apply them.";
    button.textContent = "Apply & restart";
  }

  function markApplied() {
    status.textContent = "Saved changes are now active.";
    button.textContent = "Restart runtime";
  }

  async function applySavedConfiguration() {
    if (busy) return;
    const workspace = getWorkspace();
    if (!workspace?.beginExternalRuntimeMutation("saved configuration")) return;
    const environment = getEnvironmentId();
    let activated = false;
    busy = true;
    button.disabled = true;
    status.textContent = "Restarting with saved settings…";
    try {
      const result = await apply();
      if (environment !== getEnvironmentId()) return;
      if (result?.activation?.status !== "ready") {
        status.textContent =
          result?.activation?.message ||
          "The runtime could not restart yet. Try again when it is idle.";
        return;
      }
      activated = true;
      const refreshed = await refresh();
      if (environment !== getEnvironmentId()) return;
      status.textContent =
        refreshed === false
          ? "Runtime restarted. Refresh configuration to update this view."
          : "Runtime restarted. Saved settings are now active.";
    } catch (error) {
      if (environment !== getEnvironmentId()) return;
      if (activated) {
        status.textContent =
          "Runtime restarted. Refresh configuration to update this view.";
      } else {
        status.textContent =
          error instanceof Error
            ? error.message
            : "The runtime could not restart. Try again.";
      }
    } finally {
      busy = false;
      button.disabled = false;
      if (activated) button.textContent = "Restart runtime";
      workspace.endExternalRuntimeMutation();
      if (environment !== getEnvironmentId()) {
        status.textContent =
          "Environment changed. Restart with saved settings when idle.";
        button.textContent = "Restart runtime";
      }
    }
    if (!activated) return;
    if (environment !== getEnvironmentId()) return;
    if (onAppliedSettled() === false)
      status.textContent =
        "Runtime restarted. Finish your current edits, then refresh configuration to update environments.";
  }

  button.addEventListener("click", applySavedConfiguration);
  return { markPending, markApplied };
}
