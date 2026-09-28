const navigation = Object.freeze({
  home: "homeWorkspaceButton", chat: "chatWorkspaceButton", learning: "learningWorkspaceButton",
  memory: "memoryWorkspaceButton", schedules: "schedulesWorkspaceButton", models: "modelsWorkspaceButton",
  plugins: "pluginsWorkspaceButton", notifications: "notificationsWorkspaceButton", config: "configWorkspaceButton",
});

function requiresInitialSetup(availability, previous, observed) {
  if (!availability) return false;
  if (availability.recovery === "configuration") return false;
  if (availability.status === "ready") return false;
  if (["loading", "setup_required"].includes(availability.status)) return true;
  // A refresh or network failure does not turn an already configured app into onboarding.
  return observed ? previous : true;
}

/** Project onboarding readiness onto navigation without changing feature/backend support. */
export function createOnboardingWorkspaceAccess({ dom, backendAllows }) {
  let initialSetup = false;
  let observed = false;

  function isAvailable(workspace) {
    if (workspace === "home") return true;
    if (initialSetup) return false;
    return backendAllows(workspace);
  }

  function render() {
    for (const [workspace, key] of Object.entries(navigation)) {
      const button = dom[key];
      if (!button) continue;
      const blocked = initialSetup && workspace !== "home";
      button.disabled = !isAvailable(workspace);
      button.setAttribute("aria-disabled", String(button.disabled));
      button.dataset.onboardingBlocked = String(blocked);
      if (blocked) button.setAttribute("aria-description", "Complete initial setup on Home to open this page.");
      else button.removeAttribute("aria-description");
    }
    if (dom.learningWorkspaceButton) dom.learningWorkspaceButton.hidden = initialSetup;
  }

  function update(availability) {
    initialSetup = requiresInitialSetup(availability, initialSetup, observed);
    observed = true;
    render();
  }

  function unavailableMessage() {
    if (initialSetup) return "Complete initial setup on Home to open this page.";
    return "This workspace is unavailable with the current backend.";
  }

  return { isAvailable, render, update, unavailableMessage };
}
