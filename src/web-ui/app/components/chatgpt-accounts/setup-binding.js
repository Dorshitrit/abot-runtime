import { createChatgptAccountConnection } from "./connection.js";

/** Mount an account selector into either setup flow without giving it model-profile policy. */
export function createChatgptSetupBinding({ state, client, getEnvironmentId, getContainer, getProvider, getAccountRef, render, modelField }) {
  let mounted = false;
  function hasSetupAccountChanged(value) {
    if (state.accountRef !== value.accountRef) return true;
    return state.chatgptAccountReady !== value.ready;
  }
  const connection = createChatgptAccountConnection({
    client, getEnvironmentId,
    onChange(value) {
      const accountChanged = hasSetupAccountChanged(value);
      state.accountRef = value.accountRef;
      state.chatgptAccountReady = value.ready;
      if (!mounted) return;
      if (accountChanged) render();
    },
    onModel(value) {
      const input = getContainer()?.querySelector('[data-runtime-setup-field="model-id"]');
      if (!input) return;
      input.value = value;
      // Use the same user-edit path, including profile naming and existing validation.
      input.dispatchEvent(new Event("input", { bubbles: true }));
      state[modelField] = value;
    },
  });
  function mount() {
    const provider = getProvider();
    const root = getContainer()?.querySelector("[data-chatgpt-connection]");
    if (provider.type !== "openai-chatgpt" || !root) {
      if (mounted) connection.reset();
      mounted = false;
      return;
    }
    mounted = true;
    connection.mount(root, { accountRef: getAccountRef(), locked: Boolean(provider.existing) });
  }
  function reset() { mounted = false; connection.reset(); state.chatgptAccountReady = false; state.accountRef = ""; }
  return { mount, reset };
}
