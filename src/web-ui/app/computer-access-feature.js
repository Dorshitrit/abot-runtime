import { createSystemHostConnectionManager } from "./components/system-host/manager.js";
import { createSystemHostSetupNotice } from "./components/system-host/setup-notice.js";
import { computerAccessWidgetSummary } from "./components/system-host/home-widget-summary.js";

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
  let notice;
  let unregisterWidget = () => {};
  const connection = createSystemHostConnectionManager({
    documentRoot,
    compact: true,
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
      notice?.render();
      compactHomeWidgets?.refresh();
      onChange();
    },
  });

  function open() {
    if (!isComputerAccessAvailable()) return false;
    dom.homeWorkspaceButton?.click();
    if (dom.homeWorkspacePanel?.hidden !== false || !root) return false;
    if (!compactHomeWidgets?.open("computer")) connection.openManagement();
    root.scrollIntoView?.({ block: "start", behavior: "smooth" });
    root.focus({ preventScroll: true });
    return true;
  }

  function runtimeAvailabilityChanged() {
    const ready = isComputerAccessAvailable();
    if (root) root.hidden = !ready;
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
    connection.mount(root);
    unregisterWidget = compactHomeWidgets?.register({
      id: "computer", label: "Computer access", icon: "computer", element: root,
      isAvailable: isComputerAccessAvailable,
      getSummary: () => computerAccessWidgetSummary(connection.state, runtimeClient.supportsSystemHostConnection()),
      onOpen: connection.openManagement,
    }) || unregisterWidget;
    runtimeAvailabilityChanged();
  }
  dom.environmentSelect?.addEventListener("change", connection.environmentChanged);
  return {
    state: connection.state,
    load,
    open,
    runtimeAvailabilityChanged,
    dispose() {
      unregisterWidget();
      dom.environmentSelect?.removeEventListener("change", connection.environmentChanged);
      notice.dispose();
      connection.dispose();
      root?.remove();
    },
  };
}
