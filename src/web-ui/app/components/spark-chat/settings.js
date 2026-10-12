import { canChooseReasoning, reasoningModeOptions } from "../../lib/reasoning-controls.js";
import { supportsFullPlus } from "../../lib/tool-permission-mode.js";

export function createSparkChatSettings({ root, onSave, onClear, onOpen, onResetPosition, onOpenModelSettings, getAgentMode, onAgentModeChange, getWebConfig, documentRoot = document }) {
  const card = documentRoot.createElement("section");
  card.className = "spark-chat-settings";
  card.setAttribute("aria-label", "SPARK conversation settings");
  card.innerHTML = `<header class="spark-settings-header"><div><h4>SPARK chat</h4>
      <p>A familiar place to talk, wherever you are.</p></div><button type="button" data-spark-open>Open chat</button></header>
    <form class="spark-settings-row spark-chat-settings-controls">
      <label for="spark-chat-permissions"><strong>Permissions</strong><span>Choose when SPARK asks before taking action.</span></label>
      <div class="spark-settings-actions"><select id="spark-chat-permissions" data-spark-permissions aria-label="SPARK conversation permissions"><option value="ask">Ask</option><option value="full_access">Full</option><option value="full_plus">FULL+</option></select>
      <button type="submit" data-spark-save disabled>Save</button></div>
    </form>
    <div class="spark-settings-row">
      <label for="spark-agent-mode"><strong>Thinking mode</strong><span>Choose how deeply SPARK thinks before replying.</span></label>
      <select id="spark-agent-mode" data-spark-agent-mode aria-label="SPARK thinking mode"><option value="fast">Fast</option><option value="reasoning" selected>Reasoning</option><option value="deep">Deep</option></select>
    </div>
    <div class="spark-settings-row"><div><strong>Chat shortcut</strong><p>Drag SPARK wherever feels right. Use Alt + arrow keys to move it.</p></div>
      <button type="button" data-spark-reset-position>Return to sidebar</button></div>
    <div class="spark-settings-row"><div><strong>Conversation history</strong><p>Clear messages while keeping SPARK’s memory and permissions.</p></div>
      <button type="button" data-spark-clear>Clear messages…</button></div>
    <p class="spark-settings-model-note">Chat shares the model selected under Proactive mode, including “Same as learning” when selected. <button type="button" data-spark-model-settings>Model settings ↗</button></p>
    <p data-spark-settings-feedback role="status" aria-live="polite"></p>`;
  root?.querySelector('[data-learning-panel="chat"]')?.prepend(card);
  const select = card.querySelector("[data-spark-permissions]");
  const agentModeSelect = card.querySelector("[data-spark-agent-mode]");
  const save = card.querySelector("[data-spark-save]");
  const clear = card.querySelector("[data-spark-clear]");
  const feedback = card.querySelector("[data-spark-settings-feedback]");
  let saved = "ask";
  let ready = false;
  let reasoningEnabled = false;
  let busy = false;
  let environmentId;
  function controls() {
    select.disabled = busy || !ready;
    agentModeSelect.disabled = !ready || !reasoningEnabled;
    save.disabled = busy || !ready || select.value === saved;
    clear.disabled = busy || !ready;
  }
  async function perform(action, successMessage = "") {
    const environment = environmentId;
    busy = true; feedback.textContent = ""; controls();
    try {
      await action();
      if (environment === environmentId) feedback.textContent = successMessage;
    }
    catch (error) {
      if (environment === environmentId) feedback.textContent = error.code === "spark_chat_busy"
        ? "Stop the active request or resolve its approval before clearing SPARK chat."
        : error.message;
    }
    finally { if (environment === environmentId) { busy = false; controls(); } }
  }
  select.addEventListener("change", controls);
  agentModeSelect.addEventListener("change", () => { if (reasoningEnabled) onAgentModeChange(agentModeSelect.value); });
  card.querySelector("form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (save.disabled) return;
    const mode = select.value;
    void perform(() => onSave(mode), "Permissions saved.");
  });
  clear.addEventListener("click", () => {
    if (clear.disabled) return;
    if (!window.confirm("Clear all messages in the SPARK conversation? Long-term memory and permissions will be kept.")) return;
    void perform(onClear);
  });
  card.querySelector("[data-spark-open]").addEventListener("click", onOpen);
  card.querySelector("[data-spark-reset-position]").addEventListener("click", () => onResetPosition?.());
  card.querySelector("[data-spark-model-settings]").addEventListener("click", () => onOpenModelSettings?.());
  return {
    render(configuration, nextEnvironmentId) {
      if (environmentId !== nextEnvironmentId) {
        environmentId = nextEnvironmentId; busy = false; ready = false; feedback.textContent = "";
        select.value = configuration?.toolPermissionMode || "ask";
      }
      reasoningEnabled = canChooseReasoning(configuration);
      agentModeSelect.innerHTML = reasoningModeOptions(getAgentMode(), reasoningEnabled);
      agentModeSelect.title = reasoningEnabled ? "Reasoning depth" : "Enable reasoning controls for this model in Models.";
      const next = configuration?.toolPermissionMode || "ask";
      if (!ready || select.value === saved || busy) select.value = next;
      saved = next; ready = Boolean(configuration?.sessionId);
      select.querySelector('[value="full_plus"]').disabled = !supportsFullPlus(getWebConfig());
      controls();
    },
  };
}
