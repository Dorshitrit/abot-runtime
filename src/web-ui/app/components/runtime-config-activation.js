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
  panel.setAttribute("aria-label", "Apply saved configuration");
  panel.innerHTML =
    '<p role="status" aria-live="polite">Apply saved changes when your agent is idle.</p><button type="button">Apply changes</button>';
  const status = panel.querySelector("p");
  const button = panel.querySelector("button");
  root.prepend(panel);
  let busy = false;

  function markPending() {
    status.textContent = "Changes saved. Apply them to update your agent.";
  }

  function markApplied() {
    status.textContent = "Saved changes are now active.";
  }

  async function applySavedConfiguration() {
    if (busy) return;
    const workspace = getWorkspace();
    if (!workspace?.beginExternalRuntimeMutation("saved configuration")) return;
    const environment = getEnvironmentId();
    let activated = false;
    busy = true;
    button.disabled = true;
    status.textContent = "Applying saved changes…";
    try {
      const result = await apply();
      if (environment !== getEnvironmentId()) return;
      if (result?.activation?.status !== "ready") {
        status.textContent =
          result?.activation?.message ||
          "Saved changes are waiting to be applied.";
        return;
      }
      activated = true;
      const refreshed = await refresh();
      if (environment !== getEnvironmentId()) return;
      status.textContent =
        refreshed === false
          ? "Changes applied. Refresh configuration to update this view."
          : "Saved changes are now active.";
    } catch (error) {
      if (environment !== getEnvironmentId()) return;
      if (activated) {
        status.textContent =
          "Changes applied. Refresh configuration to update this view.";
      } else {
        status.textContent =
          error instanceof Error
            ? error.message
            : "Changes could not be applied. Try again.";
      }
    } finally {
      busy = false;
      button.disabled = false;
      workspace.endExternalRuntimeMutation();
      if (environment !== getEnvironmentId()) {
        status.textContent =
          "Environment changed. Apply saved changes when your agent is idle.";
      }
    }
    if (!activated) return;
    if (environment !== getEnvironmentId()) return;
    if (onAppliedSettled() === false)
      status.textContent =
        "Changes applied. Finish your current edits, then refresh configuration to update environments.";
  }

  button.addEventListener("click", applySavedConfiguration);
  return { markPending, markApplied };
}
