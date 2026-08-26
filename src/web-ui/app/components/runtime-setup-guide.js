import { escapeAttribute, escapeHtml, textOf } from "../lib/text-format.js";

const PROVIDERS = new Set(["ollama", "openai"]);
const COMMAND_IDS = ["ollama-pull", "setup", "model-gateway", "web-ui"];
const SAFE_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_@+.:/=-]*$/;
const SAFE_ORIGIN_HOST_PATTERN =
  /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+)(?::[0-9]+)?$/;
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

function normalizeProvider(value) {
  const provider = textOf(value).trim().toLowerCase();
  return PROVIDERS.has(provider) ? provider : "";
}

export function validateRuntimeSetupModelId(value) {
  const modelId = textOf(value);
  if (!modelId.trim()) {
    return { valid: false, value: "", message: "Enter a model ID." };
  }
  if (modelId.startsWith("--")) {
    return {
      valid: false,
      value: "",
      message: "Model ID cannot start with --.",
    };
  }
  if (!SAFE_MODEL_ID_PATTERN.test(modelId)) {
    return {
      valid: false,
      value: "",
      message:
        "Start with a letter or number. After that, use only letters, numbers, and _ @ + . : / = -.",
    };
  }
  return { valid: true, value: modelId, message: "" };
}

export function validateRuntimeSetupBaseUrl(value) {
  const raw = textOf(value).trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return {
      valid: false,
      value: "",
      message: "Enter an HTTP or HTTPS origin without a path.",
    };
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !SAFE_ORIGIN_HOST_PATTERN.test(parsed.host) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname && parsed.pathname !== "/")
  ) {
    return {
      valid: false,
      value: "",
      message: "Enter an HTTP or HTTPS origin without a path.",
    };
  }
  return {
    valid: true,
    value: `${parsed.protocol}//${parsed.host}`,
    message: "",
  };
}

export function buildRuntimeSetupCommands(
  provider,
  modelId,
  ollamaBaseUrl = DEFAULT_OLLAMA_BASE_URL,
  setupCommandMode = "source",
) {
  const selectedProvider = normalizeProvider(provider);
  const validation = validateRuntimeSetupModelId(modelId);
  const baseUrlValidation = validateRuntimeSetupBaseUrl(ollamaBaseUrl);
  const providerArgument = selectedProvider || "<provider>";
  const modelArgument = validation.valid ? validation.value : "<model-id>";
  const baseUrlArgument = baseUrlValidation.valid
    ? baseUrlValidation.value
    : "<ollama-base-url>";
  const packaged = setupCommandMode === "package";
  const initPrefix = packaged ? "npx abot init" : "npm run init --";
  const init = `${initPrefix} --provider ${providerArgument} --model ${modelArgument}${
    selectedProvider === "ollama" ? ` --base-url ${baseUrlArgument}` : ""
  }`;
  return {
    "ollama-pull": `ollama pull ${modelArgument}`,
    setup: init,
    "model-gateway": packaged ? "npx abot start" : "npm run model-gateway",
    "web-ui": packaged ? "" : "npm run web-ui",
  };
}

function statusMeta(setup) {
  if (setup?.status === "checking") {
    return {
      label: "Checking the model catalog…",
      tone: "checking",
      detail:
        "This refresh only checks whether a configured model is available.",
    };
  }
  if (setup?.status === "error") {
    return {
      label: "Could not check the model catalog",
      tone: "error",
      detail: textOf(
        setup.message,
        "Make sure the model gateway and Web UI are running, then try again.",
      ),
    };
  }
  return {
    label: "Setup needed",
    tone: "setup",
    detail: textOf(
      setup?.message,
      "Connect a provider and model before starting a conversation.",
    ),
  };
}

function commandBlock({ command, disabled = false, id, label }) {
  return `
    <div class="runtime-terminal">
      <div class="runtime-terminal-heading">
        <span>${escapeHtml(label)}</span>
        <button
          type="button"
          data-runtime-setup-action="copy"
          data-runtime-command="${escapeAttribute(id)}"
          data-runtime-copy-button="${escapeAttribute(id)}"
          aria-describedby="runtimeSetupCopyStatus-${escapeAttribute(id)}"
          ${disabled ? "disabled" : ""}
        >Copy</button>
      </div>
      <pre><code data-runtime-command-output="${escapeAttribute(id)}">${escapeHtml(command)}</code></pre>
      <span
        class="runtime-copy-status"
        id="runtimeSetupCopyStatus-${escapeAttribute(id)}"
        data-runtime-copy-status="${escapeAttribute(id)}"
        aria-live="polite"
      ></span>
    </div>
  `;
}

export function createRuntimeSetupGuide({
  container,
  conversationRegion,
  copyText = (value) => navigator.clipboard.writeText(value),
  getSetupCommandMode = () => "source",
}) {
  let onCheckAgain = () => {};
  let bound = false;
  let currentSetup = { status: "loading" };
  let provider = "";
  let modelId = "";
  let ollamaBaseUrl = DEFAULT_OLLAMA_BASE_URL;

  function commands() {
    return buildRuntimeSetupCommands(
      provider,
      modelId,
      ollamaBaseUrl,
      getSetupCommandMode(),
    );
  }

  function setCopyStatus(commandId, message, failed = false) {
    const status = container.querySelector(
      `[data-runtime-copy-status="${commandId}"]`,
    );
    if (!status) return;
    status.textContent = message;
    status.classList?.toggle("error", failed);
  }

  function updateModelValidation() {
    const validation = validateRuntimeSetupModelId(modelId);
    const input = container.querySelector("[data-runtime-setup-model]");
    input?.setAttribute?.(
      "aria-invalid",
      modelId && !validation.valid ? "true" : "false",
    );
    input?.setCustomValidity?.(
      modelId && !validation.valid ? validation.message : "",
    );
    const help = container.querySelector("[data-runtime-model-help]");
    if (help) {
      help.textContent = validation.valid
        ? `Use the exact model name understood by ${provider === "openai" ? "OpenAI" : provider === "ollama" ? "Ollama" : "your provider"}.`
        : validation.message;
      help.classList?.toggle("error", Boolean(modelId) && !validation.valid);
    }
    return validation;
  }

  function updateBaseUrlValidation() {
    if (provider !== "ollama") {
      return { valid: true, value: "", message: "" };
    }
    const validation = validateRuntimeSetupBaseUrl(ollamaBaseUrl);
    const input = container.querySelector("[data-runtime-setup-base-url]");
    input?.setAttribute?.("aria-invalid", validation.valid ? "false" : "true");
    input?.setCustomValidity?.(validation.valid ? "" : validation.message);
    const help = container.querySelector("[data-runtime-base-url-help]");
    if (help) {
      help.classList?.toggle("error", !validation.valid);
    }
    return validation;
  }

  function updateCommandPreview() {
    const values = commands();
    const modelValidation = updateModelValidation();
    const baseUrlValidation = updateBaseUrlValidation();
    for (const commandId of COMMAND_IDS) {
      const output = container.querySelector(
        `[data-runtime-command-output="${commandId}"]`,
      );
      if (output) output.textContent = values[commandId];
      const button = container.querySelector(
        `[data-runtime-copy-button="${commandId}"]`,
      );
      if (button) {
        const modelRequired = ["ollama-pull", "setup"].includes(commandId);
        button.disabled =
          (modelRequired && !modelValidation.valid) ||
          (commandId === "setup" &&
            (!provider || (provider === "ollama" && !baseUrlValidation.valid)));
      }
    }
  }

  async function copyCommand(commandId) {
    if (!COMMAND_IDS.includes(commandId)) return;
    const validation = validateRuntimeSetupModelId(modelId);
    if (commandId === "setup" && !provider) {
      setCopyStatus("setup", "Choose a provider before copying.", true);
      container.querySelector("[data-runtime-setup-provider]")?.focus?.();
      return;
    }
    if (["ollama-pull", "setup"].includes(commandId) && !validation.valid) {
      const input = container.querySelector("[data-runtime-setup-model]");
      input?.setCustomValidity?.(validation.message);
      input?.reportValidity?.();
      input?.focus?.();
      setCopyStatus(commandId, validation.message, true);
      return;
    }
    const baseUrlValidation = validateRuntimeSetupBaseUrl(ollamaBaseUrl);
    if (
      commandId === "setup" &&
      provider === "ollama" &&
      !baseUrlValidation.valid
    ) {
      const input = container.querySelector("[data-runtime-setup-base-url]");
      input?.setCustomValidity?.(baseUrlValidation.message);
      input?.reportValidity?.();
      input?.focus?.();
      setCopyStatus("setup", baseUrlValidation.message, true);
      return;
    }
    try {
      await copyText(commands()[commandId]);
      setCopyStatus(commandId, "Copied");
    } catch {
      setCopyStatus(commandId, "Could not copy", true);
    }
  }

  function bind({ onCheckAgain: checkAgain = () => {} } = {}) {
    onCheckAgain = checkAgain;
    if (bound) return;
    bound = true;

    container.addEventListener("click", (event) => {
      const action = event.target.closest?.("[data-runtime-setup-action]");
      if (!action) return;
      if (action.dataset.runtimeSetupAction === "check") {
        void onCheckAgain();
        return;
      }
      if (action.dataset.runtimeSetupAction === "copy") {
        void copyCommand(action.dataset.runtimeCommand);
      }
    });

    container.addEventListener("change", (event) => {
      const field = event.target.closest?.("[data-runtime-setup-field]");
      if (field?.dataset.runtimeSetupField !== "provider") return;
      provider = normalizeProvider(field.value);
      render(currentSetup);
      container
        .querySelector(
          `[data-runtime-setup-field="provider"][value="${provider}"]`,
        )
        ?.focus?.();
    });

    container.addEventListener("input", (event) => {
      const field = event.target.closest?.("[data-runtime-setup-field]");
      if (!field) return;
      if (field.dataset.runtimeSetupField === "model-id") {
        modelId = textOf(field.value);
      } else if (field.dataset.runtimeSetupField === "ollama-base-url") {
        ollamaBaseUrl = textOf(field.value);
      } else {
        return;
      }
      field.setCustomValidity?.("");
      updateCommandPreview();
    });
  }

  function render(setup) {
    currentSetup = setup || { status: "loading" };
    const status = currentSetup.status;
    const visible =
      ["checking", "error", "setup_required"].includes(status) &&
      currentSetup.showGuide !== false;
    container.hidden = !visible;
    conversationRegion.hidden = visible;
    if (!visible) {
      container.replaceChildren();
      return;
    }

    const statusCopy = statusMeta(currentSetup);
    const commandValues = commands();
    const modelValidation = validateRuntimeSetupModelId(modelId);
    const baseUrlValidation = validateRuntimeSetupBaseUrl(ollamaBaseUrl);
    const checking = status === "checking";
    const packaged = getSetupCommandMode() === "package";
    const openAiSelected = provider === "openai";
    const ollamaSelected = provider === "ollama";
    const commandStep = ollamaSelected ? 4 : 3;
    const restartStep = ollamaSelected ? 5 : 4;

    container.innerHTML = `
      <div class="runtime-setup-card" aria-busy="${checking ? "true" : "false"}">
        <div class="runtime-setup-copy">
          <h3>Connect your first model</h3>
          <p>ABot is already running. This guide gives you the commands to finish setup, but it cannot run commands or restart services for you.</p>
        </div>

        <div class="runtime-setup-status ${escapeAttribute(statusCopy.tone)}" role="status">
          <strong>${escapeHtml(statusCopy.label)}</strong>
          <span>${escapeHtml(statusCopy.detail)}</span>
        </div>

        <fieldset class="runtime-provider-fieldset">
          <legend><span>1</span> Choose a provider</legend>
          <div class="runtime-provider-options">
            <label class="runtime-provider-option">
              <input
                type="radio"
                name="runtimeSetupProvider"
                value="ollama"
                data-runtime-setup-field="provider"
                data-runtime-setup-provider
                required
                ${provider === "ollama" ? "checked" : ""}
              />
              <span><strong>Ollama</strong><small>Run a model locally.</small></span>
            </label>
            <label class="runtime-provider-option">
              <input
                type="radio"
                name="runtimeSetupProvider"
                value="openai"
                data-runtime-setup-field="provider"
                required
                ${openAiSelected ? "checked" : ""}
              />
              <span><strong>OpenAI</strong><small>Use a hosted OpenAI model.</small></span>
            </label>
          </div>
        </fieldset>

        <div class="runtime-model-field">
          <label for="runtimeSetupModelId"><span>2</span> Enter the model ID</label>
          <input
            id="runtimeSetupModelId"
            type="text"
            value="${escapeAttribute(modelId)}"
            placeholder="Exact provider model ID"
            autocomplete="off"
            spellcheck="false"
            required
            aria-required="true"
            aria-invalid="${modelId && !modelValidation.valid ? "true" : "false"}"
            aria-describedby="runtimeSetupModelHelp"
            data-runtime-setup-field="model-id"
            data-runtime-setup-model
          />
          <small id="runtimeSetupModelHelp" data-runtime-model-help>${escapeHtml(
            modelValidation.valid
              ? `Use the exact model name understood by ${openAiSelected ? "OpenAI" : provider === "ollama" ? "Ollama" : "your provider"}.`
              : modelValidation.message,
          )}</small>
        </div>

        ${
          ollamaSelected
            ? `<div class="runtime-model-field">
                <label for="runtimeSetupBaseUrl"><span>3</span> Enter the Ollama address</label>
                <input
                  id="runtimeSetupBaseUrl"
                  type="url"
                  value="${escapeAttribute(ollamaBaseUrl)}"
                  placeholder="http://127.0.0.1:11434"
                  autocomplete="off"
                  spellcheck="false"
                  required
                  aria-required="true"
                  aria-invalid="${baseUrlValidation.valid ? "false" : "true"}"
                  aria-describedby="runtimeSetupBaseUrlHelp"
                  data-runtime-setup-field="ollama-base-url"
                  data-runtime-setup-base-url
                />
                <small id="runtimeSetupBaseUrlHelp" data-runtime-base-url-help class="${baseUrlValidation.valid ? "" : "error"}">
                  ${
                    baseUrlValidation.valid
                      ? `Use the address that ABot can reach. Common setups: same environment — <code>http://127.0.0.1:11434</code>; Docker Desktop with Ollama on the Windows or macOS host — <code>http://host.docker.internal:11434</code>; another host — enter its reachable HTTP address.`
                      : escapeHtml(baseUrlValidation.message)
                  }
                </small>
              </div>`
            : ""
        }

        <section class="runtime-setup-section" aria-labelledby="runtimeSetupCommandsTitle">
          <h4 id="runtimeSetupCommandsTitle"><span>${commandStep}</span> Run the generated commands</h4>
          <p>The initializer creates machine-local <code>.env</code> and <code>local/*.config.json</code> files. It keeps existing files unless you explicitly use <code>--force</code>.</p>
          ${
            ollamaSelected
              ? commandBlock({
                  command: commandValues["ollama-pull"],
                  disabled: !modelValidation.valid,
                  id: "ollama-pull",
                  label: "Ollama host terminal · download the model",
                })
              : ""
          }
          ${commandBlock({
            command: commandValues.setup,
            disabled:
              !provider ||
              !modelValidation.valid ||
              (ollamaSelected && !baseUrlValidation.valid),
            id: "setup",
            label: openAiSelected
              ? "Runtime terminal · initialize OpenAI"
              : ollamaSelected
                ? "Runtime terminal · initialize ABot"
                : "Runtime terminal · initialize your provider",
          })}
          ${
            openAiSelected
              ? `<div class="runtime-secret-note">
                  <strong>Keep your API key out of this page</strong>
                  <p>After initialization, set <code>OPENAI_API_KEY</code> in <code>.env</code> with your local editor or secret manager. The Web UI does not request, display, or store the secret.</p>
                </div>`
              : ollamaSelected
                ? `<p class="runtime-provider-note">Run the download command where Ollama is installed. Run the initializer from the ${packaged ? "consumer project directory" : "ABot repository root"}. These may be the same environment or different ones.</p>`
                : `<p class="runtime-provider-note">Choose Ollama or OpenAI to generate the provider-specific setup command.</p>`
          }
        </section>

        <section class="runtime-setup-section" aria-labelledby="runtimeSetupRestartTitle">
          <h4 id="runtimeSetupRestartTitle"><span>${restartStep}</span> ${packaged ? "Restart ABot" : "Restart both local services"}</h4>
          <p>${packaged ? "Stop the currently running ABot process with" : "Stop the currently running model gateway and Web UI with"} <kbd>Ctrl</kbd>+<kbd>C</kbd>, then ${packaged ? "start it again" : "start each again in its own terminal"}. A process that started before <code>.env</code> existed cannot discover the new config pointer without a restart.</p>
          <div class="runtime-restart-commands">
            ${commandBlock({
              command: commandValues["model-gateway"],
              id: "model-gateway",
              label: packaged
                ? "Runtime terminal · ABot services"
                : "Terminal 1 · model gateway",
            })}
            ${
              packaged
                ? ""
                : commandBlock({
                    command: commandValues["web-ui"],
                    id: "web-ui",
                    label: "Terminal 2 · Web UI",
                  })
            }
          </div>
        </section>

        <div class="runtime-setup-footer">
          <p><strong>Check again</strong> performs one model-catalog refresh. It does not run setup, reread a newly created <code>.env</code>, or restart either service.</p>
          <button
            class="runtime-setup-action"
            type="button"
            data-runtime-setup-action="check"
            ${checking ? "disabled" : ""}
          >${checking ? "Checking…" : "Check again"}</button>
        </div>
      </div>
    `;
    updateCommandPreview();
  }

  function focusAction() {
    container.querySelector('[data-runtime-setup-action="check"]')?.focus?.();
  }

  return { bind, focusAction, render };
}
