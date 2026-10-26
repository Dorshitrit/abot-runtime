const timeoutReviewReasons = {
  shared_calibration_slot: "This timeout is shared by several steps. Review its scope in Model settings.",
  shared_profile_file: "This configuration is shared by several model profiles. Review it in Model settings.",
  profile_inline_overrides: "This profile combines configuration sources. Review its effective timeout in Model settings.",
  no_profile_step_target: "This step has no individual model timeout setting. Review its configuration in Model settings.",
  direct_profile_selection: "This step uses a direct model binding. Review its timeout in Model settings.",
  already_saved: "The doubled timeout is already saved. Apply saved settings from Models if Runtime has not restarted yet.",
  timeout_limit: "The timeout is already too large to double. Review it in Model settings.",
};

function timeoutActionLabel({ busy, saved }) {
  if (busy) return "Working…";
  if (saved) return "Restart";
  return "Double & restart";
}

/** A passive, non-modal suggestion. Never moves focus into the notice. */
export function createStepTimeoutNotice({ documentRoot = document, onIncrease, onDismiss, onSettings }) {
  const root = documentRoot.createElement("aside");
  root.className = "step-timeout-notice";
  root.hidden = true;
  root.setAttribute("aria-label", "Model timeout suggestion");
  root.innerHTML = `<button type="button" class="step-timeout-dismiss" aria-label="Dismiss timeout suggestion">×</button>
    <p class="step-timeout-heading">Give this step more time?</p>
    <p class="step-timeout-target"></p>
    <p class="step-timeout-description"></p>
    <div class="step-timeout-actions">
      <button type="button" data-timeout-increase>Double & restart</button>
      <button type="button" data-timeout-settings>Model settings</button>
    </div>
    <p class="step-timeout-status" role="status" aria-live="polite"></p>`;
  const target = root.querySelector(".step-timeout-target");
  const description = root.querySelector(".step-timeout-description");
  const status = root.querySelector(".step-timeout-status");
  const increase = root.querySelector("[data-timeout-increase]");
  const settings = root.querySelector("[data-timeout-settings]");
  root.querySelector(".step-timeout-dismiss").addEventListener("click", onDismiss);
  increase.addEventListener("click", () => void onIncrease());
  settings.addEventListener("click", onSettings);
  documentRoot.body.append(root);
  return {
    render(state) {
      root.hidden = !state;
      if (!state) return;
      const { suggestion, busy, saved, applied, message } = state;
      const seconds = (value) => `${Math.round(value / 100) / 10}s`;
      target.textContent = `${suggestion.model} · ${suggestion.modelStep}`;
      description.textContent = suggestion.canIncrease
        ? `${seconds(suggestion.timeoutMs)} → ${seconds(suggestion.proposedTimeoutMs)} for future calls. Restart applies all saved settings when Runtime is idle.`
        : timeoutReviewReasons[suggestion.reason] || "Settings have changed since this timeout. Review the current model settings.";
      increase.hidden = !suggestion.canIncrease || applied;
      increase.disabled = busy;
      increase.textContent = timeoutActionLabel(state);
      settings.hidden = suggestion.canIncrease && !message;
      status.textContent = message;
      status.hidden = !message;
    },
    dispose() { root.remove(); },
  };
}
