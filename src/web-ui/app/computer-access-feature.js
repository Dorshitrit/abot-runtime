import { createSystemHostConnectionManager } from "./components/system-host/manager.js";
import { createSystemHostSetupNotice } from "./components/system-host/setup-notice.js";

/** One connection owner, always first on Home and shared with the chat notice. */
export function createComputerAccessFeature({
  dom,
  runtimeClient,
  onChange = () => {},
}) {
  const documentRoot = dom.homeDashboardRoot?.ownerDocument;
  const root = documentRoot?.createElement("section");
  let notice;
  const connection = createSystemHostConnectionManager({
    documentRoot,
    compact: true,
    loadConnection: () => runtimeClient.getSystemHostConnection(),
    connectLocal: () => runtimeClient.connectLocalSystemHost(),
    createPairing: () => runtimeClient.createSystemHostPairing(),
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
    dom.homeWorkspaceButton?.click();
    if (dom.homeWorkspacePanel?.hidden !== false || !root) return false;
    connection.openManagement();
    root.scrollIntoView?.({ block: "start", behavior: "smooth" });
    root.focus({ preventScroll: true });
    return true;
  }

  notice = createSystemHostSetupNotice({
    container: dom.chatPanel?.querySelector(".composer-dock"),
    conversationRegion: dom.messagesList,
    getConnectionState: () => connection.state,
    supportsConnection: () => runtimeClient.supportsSystemHostConnection(),
    refreshConnection: () => connection.load(true),
    onOpen: open,
  });
  if (root) {
    root.className = "home-computer-access";
    root.setAttribute("tabindex", "-1");
    root.setAttribute("aria-label", "Computer access");
    dom.homeDashboardRoot.parentElement?.insertBefore(
      root,
      dom.homeDashboardRoot,
    );
    connection.mount(root);
    connection.setActive(true);
  }
  return {
    state: connection.state,
    load: connection.load,
    open,
    dispose() {
      notice.dispose();
      connection.dispose();
      root?.remove();
    },
  };
}
