import { createSkillsController } from "./controllers/skills-controller.js";
import { mountSkillsWorkspace, createSkillsWorkspace } from "./components/skills/workspace.js";

export function createSkillsFeature({ dom, client, shell, getEnvironmentId,
  documentRoot = document, viewport = window }) {
  mountSkillsWorkspace(dom, documentRoot);
  let view;
  const controller = createSkillsController({ client, getEnvironmentId,
    confirmDiscard: (message) => viewport.confirm(message), render: (snapshot) => view?.render(snapshot) });
  view = createSkillsWorkspace({ root: dom.skillsRoot, actions: controller,
    confirmArchive: (message) => viewport.confirm(message) });
  view.render(controller.snapshot());
  shell.addWorkspaceGuard(({ from, to }) => {
    if (from !== "skills" || to === "skills") return true;
    return controller.prepareLeave();
  });
  shell.subscribeWorkspaceChange((workspace) => controller.setActive(workspace === "skills"));
  function bind() {
    // Bind after the canonical transition: rejected raw changes never clear drafts.
    dom.environmentSelect.addEventListener("change", () => controller.environmentChanged());
    viewport.addEventListener("beforeunload", (event) => {
      if (!controller.isDirty()) return;
      event.preventDefault();
      event.returnValue = "";
    });
  }
  function refreshAvailability() {
    const available = client.supportsSkills();
    dom.skillsWorkspaceButton.hidden = !available;
    dom.skillsWorkspaceButton.disabled = !available || dom.skillsWorkspaceButton.dataset.onboardingBlocked === "true";
    if (!available) controller.setActive(false);
  }
  shell.subscribeRuntimeAvailabilityChange(refreshAvailability);
  return { bind, refreshAvailability, prepareEnvironmentChange: controller.prepareLeave,
    isWorkspaceAvailable: (destination) => destination !== "skills" || client.supportsSkills() };
}
