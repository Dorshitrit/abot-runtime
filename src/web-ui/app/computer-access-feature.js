import { createSystemHostConnectionManager } from "./components/system-host/manager.js";
import { createSystemHostSetupNotice } from "./components/system-host/setup-notice.js";
import { computerAccessWidgetSummary } from "./components/system-host/home-widget-summary.js";
import { createConnectionCard } from "./components/home-connections/card.js";
import { createComputerConnectionDialog } from "./components/system-host/home-connection-dialog.js";
import { computerConnectionCardSummary } from "./components/system-host/home-connection-summary.js";

/** One connection owner for configured Home and its shared chat notice. */
export function createComputerAccessFeature({
  dom,
  runtimeClient,
  getEnvironmentId = () => "",
  isComputerAccessAvailable = () => true,
  compactHomeWidgets,
  onChange = () => {},
}) {
  const documentRoot = dom.homeDashboardRoot?.ownerDocument;
  const root = documentRoot?.createElement("section");
  const slot = dom.homeDashboardRoot?.querySelector("[data-home-computer]");
  const card = documentRoot ? createConnectionCard({ documentRoot, id: "computer", label: "Computer access", icon: "computer" }) : null;
  let notice;
  let homeDialog;
  let unregisterWidget = () => {};
  const connection = createSystemHostConnectionManager({
    documentRoot,
    compact: false,
    getEnvironmentId,
    loadConnection: () => runtimeClient.getSystemHostConnection(),
    connectLocal: () => runtimeClient.connectLocalSystemHost(),
    createPairing: () => runtimeClient.createSystemHostPairing(),
    requestStoreConnection: () => runtimeClient.requestSystemHostStoreConnection(),
    requestPermissions: (input) => runtimeClient.requestSystemHostPermissions(input),
    downloadSetup: (platform) =>
      runtimeClient.downloadSystemHostSetup(platform),
    revokeConnection: () => runtimeClient.revokeSystemHostConnection(),
    supportsConnection: () => runtimeClient.supportsSystemHostConnection(),
    onChange: () => {
      card?.render(computerConnectionCardSummary(connection.state, runtimeClient.supportsSystemHostConnection()));
      homeDialog?.refresh();
      notice?.render();
      compactHomeWidgets?.refresh();
      onChange();
    },
  });

  function open() {
    if (!isComputerAccessAvailable()) return false;
    dom.homeWorkspaceButton?.click();
    if (dom.homeWorkspacePanel?.hidden !== false || !root) return false;
    return homeDialog?.open() === true;
  }

  function runtimeAvailabilityChanged() {
    const ready = isComputerAccessAvailable();
    if (slot) slot.hidden = !ready;
    if (root) root.hidden = !ready;
    homeDialog?.sync();
    connection.setActive(ready);
    compactHomeWidgets?.refresh();
    notice?.render();
  }

  function load(background) {
    if (!isComputerAccessAvailable()) return Promise.resolve(false);
    return connection.load(background);
  }

  notice = createSystemHostSetupNotice({
    container: dom.chatPanel?.querySelector(".composer-dock"),
    conversationRegion: dom.messagesList,
    getConnectionState: () => connection.state,
    supportsConnection: () => isComputerAccessAvailable() && runtimeClient.supportsSystemHostConnection(),
    refreshConnection: () => load(true),
    onOpen: open,
  });
  if (root) {
    root.className = "home-computer-access";
    root.hidden = !isComputerAccessAvailable();
    root.setAttribute("tabindex", "-1");
    root.setAttribute("aria-label", "Computer access");
    dom.homeDashboardRoot.parentElement?.insertBefore(
      root,
      dom.homeDashboardRoot,
    );
    (slot || dom.homeDashboardRoot).appendChild(card.button);
    homeDialog = createComputerConnectionDialog({
      root: dom.homeDashboardRoot, homeRegion: dom.homeWorkspacePanel,
      source: root, button: card.button,
      canOpen: () => isComputerAccessAvailable() && dom.homeWorkspacePanel?.hidden === false && !documentRoot.hidden,
      getSummary: () => computerAccessWidgetSummary(connection.state, runtimeClient.supportsSystemHostConnection()),
      onOpen: connection.openManagement,
      closeShared: () => compactHomeWidgets?.close({ restoreFocus: false }),
    });
    card.button.addEventListener("click", open);
    connection.mount(root);
    unregisterWidget = compactHomeWidgets?.register({
      id: "computer", label: "Computer access", icon: "computer", element: root,
      homeCard: false,
      isAvailable: isComputerAccessAvailable,
      getSummary: () => computerAccessWidgetSummary(connection.state, runtimeClient.supportsSystemHostConnection()),
      onOpen: connection.openManagement,
      onBeforeOpen: () => homeDialog.close({ restoreFocus: false }),
    }) || unregisterWidget;
    runtimeAvailabilityChanged();
  }
  function environmentChanged() {
    homeDialog?.close({ restoreFocus: false });
    connection.environmentChanged();
  }
  dom.environmentSelect?.addEventListener("change", environmentChanged);
  return {
    state: connection.state,
    load,
    open,
    runtimeAvailabilityChanged,
    dispose() {
      unregisterWidget();
      dom.environmentSelect?.removeEventListener("change", environmentChanged);
      homeDialog?.dispose();
      notice.dispose();
      connection.dispose();
      root?.remove();
      card?.button.remove();
    },
  };
}
