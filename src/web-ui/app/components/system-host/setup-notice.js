import { createSystemHostVisibility } from "./visibility.js";

export function needsComputerSetup(state) {
  if (!state || state.busy || state.statusUnavailable) return false;
  const snapshot = state.snapshot;
  const readiness = snapshot?.readiness;
  if (snapshot?.paired || readiness?.ready !== false) return false;
  if (readiness.route !== "setup_required") return false;
  if (!["container", "wsl"].includes(readiness.environment)) return false;
  if (!Array.isArray(readiness.platforms)) return false;
  return readiness.platforms.some((platform) =>
    ["windows", "macos", "linux"].includes(platform),
  );
}

export function createSystemHostSetupNotice({
  container,
  conversationRegion,
  getConnectionState,
  supportsConnection = () => true,
  refreshConnection = () => {},
  onOpen = () => {},
}) {
  const root = container?.ownerDocument?.createElement("aside");
  if (!root) return { render() {}, dispose() {} };
  let dismissed = false;
  let disposed = false;
  const visibility = createSystemHostVisibility({
    documentRoot: container.ownerDocument,
    getRoot: () => conversationRegion,
    isActive: () => Boolean(conversationRegion),
    onChange: visibilityChanged,
  });
  let wasVisible = visibility.isVisible();
  visibility.watch();

  function visibilityChanged() {
    if (disposed) return;
    const visible = visibility.isVisible();
    const becameVisible = visible && !wasVisible;
    wasVisible = visible;
    if (becameVisible && supportsConnection()) void refreshConnection();
  }
  root.className = "system-host-setup-notice";
  root.setAttribute("aria-label", "Computer setup");
  root.hidden = true;
  root.innerHTML = `
    <span data-host-setup-description></span>
    <button type="button" class="system-host-setup-link" data-host-setup-open>Set up computer</button>
    <button type="button" class="system-host-setup-dismiss" data-host-setup-dismiss aria-label="Dismiss computer setup suggestion">×</button>`;
  const description = root.querySelector("[data-host-setup-description]");
  root.querySelector("[data-host-setup-open]").addEventListener("click", () => {
    if (!root.hidden) onOpen();
  });
  root
    .querySelector("[data-host-setup-dismiss]")
    .addEventListener("click", () => {
      dismissed = true;
      root.hidden = true;
    });
  container.prepend(root);

  function render() {
    if (disposed) return;
    const state = getConnectionState();
    const visible =
      !dismissed && supportsConnection() && needsComputerSetup(state);
    const hidden = !visible;
    if (root.hidden !== hidden) root.hidden = hidden;
    if (!visible) return;
    const text =
      state.snapshot.readiness.environment === "wsl"
        ? "Set up Windows access to use its apps and system tools."
        : "Connect your computer to use its apps and system tools.";
    if (description.textContent !== text) description.textContent = text;
  }

  render();
  return {
    render,
    dispose() {
      disposed = true;
      visibility.dispose();
      root.remove();
    },
  };
}
