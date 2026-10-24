/** Independent thinking-budget popup; effort keeps its own menu and selection. */
export function bindReasoningBudgetMenu({ state, dom, actions, modelSelector, documentRoot }) {
  const button = dom.reasoningBudgetButton, menu = dom.reasoningBudgetMenu;
  if (!button || !menu) return;
  function close(restoreFocus = false) {
    if (!state.reasoningBudgetMenuOpen) return;
    state.reasoningBudgetMenuOpen = false;
    actions.renderAgentMode();
    if (restoreFocus) button.focus();
  }
  function open() {
    if (button.disabled || dom.reasoningBudgetControl?.hidden) return;
    modelSelector.close();
    state.agentModeMenuOpen = false;
    state.permissionModeMenuOpen = false;
    state.reasoningBudgetMenuOpen = true;
    actions.renderPermissionMode();
    actions.renderAgentMode();
    menu.querySelector("[data-reasoning-preference-mode]")?.focus();
  }
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (state.reasoningBudgetMenuOpen) { close(); return; }
    open();
  });
  button.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault(); open();
  });
  menu.addEventListener("click", (event) => event.stopPropagation());
  for (const trigger of [dom.agentModeButton, dom.permissionModeButton]) {
    trigger.addEventListener("click", () => close());
    trigger.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") close();
    });
  }
  documentRoot.addEventListener("click", (event) => {
    if (event.target === button || button.contains(event.target) || menu.contains(event.target)) return;
    close();
  });
  documentRoot.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || !state.reasoningBudgetMenuOpen) return;
    close(true); event.preventDefault();
  });
}
