import { confirmDialog } from "./components/confirmation-dialog.js";
import { createInformationBasketController } from "./controllers/information-basket-controller.js";
import { createInformationBasketWorkspace } from "./components/information-basket/workspace.js";
import { mountInformationBasketWorkspace } from "./components/information-basket/mount.js";

export function createInformationBasketFeature({ dom, client, shell, realtime, getEnvironmentId,
  documentRoot = document }) {
  mountInformationBasketWorkspace(dom, documentRoot);
  let view;
  const controller = createInformationBasketController({ client, getEnvironmentId,
    isVisible: () => documentRoot.visibilityState !== "hidden",
    render: (snapshot) => view?.render(snapshot),
    confirmRemove: (count) => confirmDialog(`Remove ${count === 1 ? "this source" : `${count} sources`} from the basket? Original files will not be deleted.`,
      { title: "Remove from basket", confirmLabel: "Remove", tone: "danger" }),
  });
  view = createInformationBasketWorkspace({ root: dom.resourcesRoot, actions: controller, documentRoot });
  view.render(controller.snapshot());
  shell.subscribeWorkspaceChange((workspace) => controller.setActive(workspace === "resources"));
  function refreshAvailability() {
    const available = client.supportsInformationBasket();
    dom.resourcesWorkspaceButton.hidden = !available;
    dom.resourcesWorkspaceButton.disabled = !available || dom.resourcesWorkspaceButton.dataset.onboardingBlocked === "true";
    if (!available) controller.setActive(false);
  }
  shell.subscribeRuntimeAvailabilityChange(refreshAvailability);
  let bound = false;
  function bind() {
    if (bound) return;
    bound = true;
    dom.environmentSelect.addEventListener("change", () => controller.environmentChanged());
    documentRoot.addEventListener("visibilitychange", () => controller.visibilityChanged());
    realtime.subscribeMessages?.(controller.handleRealtime);
    realtime.subscribeConnected?.(controller.reconnect);
  }
  return { bind, refreshAvailability,
    isWorkspaceAvailable: (destination) => destination !== "resources" || client.supportsInformationBasket() };
}
