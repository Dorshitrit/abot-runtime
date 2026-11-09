import { escapeAttribute, escapeHtml } from "../../lib/text-format.js";
import { renderConnectionField } from "../runtime-setup/connection-form.js";
import { defaultSetupProviderAddress, validateRuntimeSetupBaseUrl } from "../runtime-setup/validation.js";
import { providerEditFields } from "./provider-connections.js";

function accountSelector(connection, accounts) {
  const current = connection.settings.accountRef;
  const available = accounts.filter((account) => account.status === "connected" && account.planEnabled);
  const fallback = available.some((account) => account.accountRef === current) ? "" :
    `<option value="${escapeAttribute(current)}" disabled selected>${current ? "Current account unavailable" : "Choose an account"}</option>`;
  const options = available.map((account) => `<option value="${escapeAttribute(account.accountRef)}" ${account.accountRef === current ? "selected" : ""}>${escapeHtml(account.label || account.accountRef)}</option>`);
  return `<label class="runtime-setup-field"><span>ChatGPT account</span>
    <select data-runtime-setup-field="accountRef" required>${fallback}${options.join("")}</select>
    <small>${available.length ? "Choose a connected account with plan usage enabled." : "Open ChatGPT accounts to connect an account and enable plan usage."}</small></label>`;
}

export function renderProviderFields(connection, accounts = []) {
  const { type, settings } = connection;
  const help = type === "llamacpp" && settings.apiKeyEnv
    ? "Requests to the new address will use the configured API key. Change its variable below if the server needs a different key."
    : "Enter the HTTP or HTTPS origin reachable from the computer running ABot.";
  return providerEditFields(type).map((field) => {
    if (field === "accountRef") return accountSelector(connection, accounts);
    const options = { idPrefix: "editProvider", field, value: settings[field], required: false };
    if (field === "baseUrl") return renderConnectionField({
      ...options, label: "Server address", type: "url", placeholder: defaultSetupProviderAddress(type), help,
    });
    if (field === "keepAlive") return renderConnectionField({
      ...options, label: "Keep model loaded", placeholder: "e.g. 5m",
      help: "Ollama keep-alive duration. Leave blank to use the ABot default.",
    });
    return renderConnectionField({
      ...options, label: "API key environment variable", placeholder: type === "openai" ? "OPENAI_API_KEY" : "e.g. LLAMA_API_KEY",
      help: type === "openai" ? "Enter the variable name only. A blank value uses OPENAI_API_KEY." : "Enter the variable name only. A blank value removes the API key binding.",
    });
  }).join("");
}

export function providerEdits(connection, values) {
  const edits = {};
  for (const field of providerEditFields(connection.type)) {
    if (!Object.hasOwn(values, field)) continue;
    let value = values[field].trim();
    if (value === connection.settings[field]) continue;
    if (field === "baseUrl") {
      const address = validateRuntimeSetupBaseUrl(value);
      if (!address.valid) throw new Error(address.message);
      value = address.value;
    }
    if (field === "apiKeyEnv" && value && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
      throw new Error("Enter an environment variable name, such as OPENAI_API_KEY.");
    if (value !== connection.settings[field]) edits[field] = value;
  }
  return edits;
}

export async function promptProviderEdits(root, connection, loadAccounts) {
  const dialog = root.ownerDocument.createElement("dialog");
  dialog.className = "provider-editor-dialog";
  dialog.setAttribute("aria-labelledby", "providerEditorTitle");
  dialog.innerHTML = `<form><h2 id="providerEditorTitle">Edit ${escapeHtml(connection.id)}</h2>
    <div data-provider-fields></div><p data-provider-status role="status"></p>
    <footer><button type="button" data-provider-cancel>Cancel</button><button type="submit">Save changes</button></footer></form>`;
  const fields = dialog.querySelector("[data-provider-fields]");
  const status = dialog.querySelector("[data-provider-status]");
  const save = dialog.querySelector('[type="submit"]');
  const abort = new AbortController();
  const result = new Promise((resolve) => {
    function finish(edits) {
      abort.abort();
      dialog.close();
      dialog.remove();
      resolve(edits);
    }
    dialog.querySelector("[data-provider-cancel]").addEventListener("click", () => finish(null));
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish(null); });
    dialog.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault();
      if (save.disabled) return;
      const values = Object.fromEntries(Array.from(fields.querySelectorAll("[data-runtime-setup-field]"),
        (element) => [element.dataset.runtimeSetupField, element.value]));
      try {
        const edits = providerEdits(connection, values);
        if (Object.keys(edits).length) finish(edits);
        else status.textContent = "Change a setting before saving.";
      } catch (error) {
        status.textContent = error.message;
      }
    });
  });
  try {
    if (connection.type === "openai-chatgpt") {
      save.disabled = true;
      status.textContent = "Loading ChatGPT accounts…";
    } else fields.innerHTML = renderProviderFields(connection);
    root.append(dialog);
    dialog.showModal();
    if (connection.type === "openai-chatgpt") {
      void loadAccounts({ signal: abort.signal }).then(({ accounts }) => {
        if (abort.signal.aborted) return;
        fields.innerHTML = renderProviderFields(connection, accounts);
        status.textContent = "";
        save.disabled = !accounts.some((account) => account.status === "connected" && account.planEnabled);
      }).catch(() => {
        if (!abort.signal.aborted) status.textContent = "ChatGPT accounts could not be loaded. Close this dialog and try again.";
      });
    }
    return await result;
  } finally {
    abort.abort();
    dialog.remove();
  }
}
