import { createChatgptAccountConnection } from "./connection.js";
export function createChatgptAccountSettings({ root, client, getEnvironmentId }) {
  let dialog = null;
  const connection = createChatgptAccountConnection({ client, getEnvironmentId });
  function close() {
    connection.reset();
    dialog?.close();
    dialog?.remove();
    dialog = null;
  }
  function open(accountRef = "") {
    if (dialog || !connection.supported()) return false;
    dialog = root.ownerDocument.createElement("dialog");
    dialog.className = "chatgpt-account-dialog";
    dialog.setAttribute("aria-label", "ChatGPT accounts");
    dialog.innerHTML = '<h2>ChatGPT accounts</h2><div data-chatgpt-settings></div><footer class="chatgpt-account-footer"><button type="button" class="chatgpt-account-button" data-chatgpt-close>Close</button></footer>';
    dialog.querySelector("[data-chatgpt-close]").addEventListener("click", close);
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
    root.append(dialog);
    dialog.showModal();
    connection.mount(dialog.querySelector("[data-chatgpt-settings]"), { accountRef, models: false });
    return true;
  }
  return { open, close, isOpen: () => Boolean(dialog) };
}
