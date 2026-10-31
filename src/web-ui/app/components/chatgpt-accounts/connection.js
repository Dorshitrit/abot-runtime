import { createChatgptAccountController } from "../../controllers/chatgpt-account-controller.js";
import { chatgptAuthorizationUrl, renderChatgptAccounts, CHATGPT_USAGE_URL } from "./rendering.js";

/** One bounded account flow reused by first-run setup, add-model, and account settings. */
export function createChatgptAccountConnection({ client, getEnvironmentId = () => "", onChange = () => {}, onModel = () => {}, openUrl, documentRoot }) {
  let root = null;
  let settings = {};
  let scope = getEnvironmentId();
  let welcome = null;
  let welcomeAccount = "";
  const supported = () => client?.supportsChatgptAccounts?.() === true;
  const controller = typeof client?.listChatgptAccounts === "function" ? createChatgptAccountController({
    client, getEnvironmentId, onChange: changed,
    openAuthorization(url) {
      const safe = chatgptAuthorizationUrl(url);
      if (!safe) return;
      if (openUrl) { openUrl(safe); return; }
      globalThis.window?.open(safe, "_blank", "noopener,noreferrer");
    },
  }) : null;

  function closeWelcome() {
    welcome?.close();
    welcome?.remove();
    welcome = null;
    welcomeAccount = "";
  }
  function renderWelcome() {
    const account = controller?.account();
    if (!account?.planEnabled || account.planWelcomeAcknowledged || !root) { closeWelcome(); return; }
    if (controller.state.busy && !welcome) return;
    if (welcomeAccount === account.accountRef) {
      welcome.querySelector("button").disabled = Boolean(controller.state.busy);
      welcome.querySelector('[role="status"]').textContent = controller.state.error;
      return;
    }
    closeWelcome();
    const doc = documentRoot || root.ownerDocument;
    welcome = doc.createElement("dialog");
    welcome.className = "chatgpt-plan-welcome";
    welcome.setAttribute("aria-label", "You're using your ChatGPT plan");
    welcome.innerHTML = `<h2>You're using your ChatGPT plan</h2><p>Eligible AI requests in ABot use your ChatGPT plan. You can manage usage in ChatGPT settings.</p><a href="${CHATGPT_USAGE_URL}" target="_blank" rel="noopener noreferrer">Manage usage</a><p role="status"></p><button type="button">Got it</button>`;
    welcomeAccount = account.accountRef;
    welcome.querySelector("button").addEventListener("click", () => void controller.acknowledge());
    welcome.addEventListener("cancel", (event) => { event.preventDefault(); void controller.acknowledge(); });
    doc.body.append(welcome);
    welcome.showModal();
  }
  function render() {
    if (!root || !controller) return;
    root.innerHTML = renderChatgptAccounts(controller.state, settings);
    renderWelcome();
  }
  function changed() {
    if (scope !== getEnvironmentId()) return;
    onChange({ accountRef: controller.state.accountRef, ready: controller.canUseAccount(), account: controller.account() });
    render();
  }
  function bind(node) {
    node.addEventListener("click", (event) => {
      if (node !== root) return;
      const action = event.target.closest?.("[data-chatgpt-action]")?.dataset.chatgptAction;
      if (action === "sign-in") void controller.start();
      if (action === "add") void controller.start("sign_in", "");
      if (action === "enable") void controller.start("enable_plan_usage");
      if (action === "retry") void controller.retry();
      if (action === "cancel") void controller.cancel();
      if (action === "reload") void controller.load();
      if (action === "disconnect") void controller.disconnect();
    });
    node.addEventListener("change", (event) => {
      if (node !== root) return;
      const field = event.target.dataset.chatgptField;
      if (field === "account" && !settings.locked) void controller.select(event.target.value);
      if (field !== "model" || !controller.canUseAccount()) return;
      if (controller.state.models.some((model) => model.id === event.target.value)) onModel(event.target.value);
    });
  }
  function mount(node, options = {}) {
    if (!controller || !node || !supported()) { unmount(); return; }
    if (scope !== getEnvironmentId()) reset();
    scope = getEnvironmentId();
    if (root !== node) { root = node; bind(node); }
    settings = options;
    render();
    if (!controller.state.loaded && !controller.state.busy) void controller.load(options.accountRef || "");
  }
  function unmount() { root = null; closeWelcome(); }
  function reset() { unmount(); controller?.reset(); scope = getEnvironmentId(); }
  return { mount, unmount, reset, supported };
}
