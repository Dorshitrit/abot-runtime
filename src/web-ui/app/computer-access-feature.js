import { createSystemHostConnectionManager } from "./components/system-host/manager.js";
import { createSystemHostSetupNotice } from "./components/system-host/setup-notice.js";

/** One connection owner for configured Home and its shared chat notice. */
export function createComputerAccessFeature({
  dom,
  runtimeClient,
  getEnvironmentId = () => "",
  isComputerAccessAvailable = () => true,
  onChange = () => {},
}) {
  const documentRoot = dom.homeDashboardRoot?.ownerDocument;
  const root = documentRoot?.createElement("section");
  let notice;
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
      onChange();
    },
  });

  function open() {
    if (!isComputerAccessAvailable()) return false;
    dom.homeWorkspaceButton?.click();
    if (dom.homeWorkspacePanel?.hidden !== false || !root) return false;
    connection.openManagement();
    root.scrollIntoView?.({ block: "start", behavior: "smooth" });
    root.focus({ preventScroll: true });
    return true;
  }

  function runtimeAvailabilityChanged() {
    const ready = isComputerAccessAvailable();
    if (root) root.hidden = !ready;
    connection.setActive(ready);
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
    runtimeAvailabilityChanged();
  }
  dom.environmentSelect?.addEventListener("change", connection.environmentChanged);
  return {
    state: connection.state,
    load,
    open,
    runtimeAvailabilityChanged,
    dispose() {
      dom.environmentSelect?.removeEventListener("change", connection.environmentChanged);
      notice.dispose();
      connection.dispose();
      root?.remove();
    },
  };
}
