/** Two separate destructive actions; the controller owns final confirmation. */
export function createRuntimeMaintenanceView(root, onReset) {
  root.innerHTML = `<section class="runtime-maintenance" aria-labelledby="runtimeMaintenanceTitle">
    <h3 id="runtimeMaintenanceTitle">Reset runtime data</h3>
    <p data-maintenance-scope></p>
    <div class="runtime-maintenance-actions">
      <div><button type="button" class="runtime-maintenance-delete" data-runtime-reset="sessions">Delete sessions</button>
        <p>Includes uploaded files and SPARK chat history.</p></div>
      <div><button type="button" class="runtime-maintenance-delete" data-runtime-reset="logs">Delete logs</button>
        <p>Current runtime log and its rotated archives.</p></div>
    </div>
    <p class="runtime-maintenance-status" role="status" aria-live="polite" data-maintenance-status></p>
  </section>`;
  const scope = root.querySelector("[data-maintenance-scope]");
  const status = root.querySelector("[data-maintenance-status]");
  const buttons = [...root.querySelectorAll("[data-runtime-reset]")];
  for (const button of buttons) button.addEventListener("click", () => void onReset(button.dataset.runtimeReset));
  return {
    render(snapshot) {
      root.hidden = !snapshot.available;
      scope.textContent = `Selected environment: ${snapshot.environmentId || "—"}. Each action requires confirmation.`;
      status.textContent = snapshot.message;
      status.classList.toggle("error-text", snapshot.failed);
      for (const button of buttons) button.disabled = snapshot.pending || !snapshot.environmentId;
    },
  };
}
