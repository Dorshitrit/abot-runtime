import { confirmDialog } from "../confirmation-dialog.js";
import { canChooseReasoningBudget, readReasoningPreferenceField, renderReasoningPreferenceField, syncReasoningPreferenceField } from "../../lib/reasoning-preference.js";
import { canChooseReasoning, reasoningModeOptions } from "../../lib/reasoning-controls.js";
import { supportsFullPlus } from "../../lib/tool-permission-mode.js";

export function createSparkChatSettings({ root, onSave, onClear, onOpen, onResetPosition, onOpenModelSettings, getAgentMode, onAgentModeChange, getReasoningPreference = () => undefined, onReasoningPreferenceChange, getWebConfig, confirmClear = (message) => confirmDialog(message, { title: "Clear SPARK conversation", confirmLabel: "Clear messages", tone: "danger" }), documentRoot = document }) {
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
    <div class="spark-settings-row" data-spark-legacy-reasoning>
      <label for="spark-agent-mode"><strong>Thinking mode</strong><span>Sets the default depth; model profile and calibration settings may override it. Token budgets are separate. Changing the mode turns Thinking Off back on.</span></label>
      <select id="spark-agent-mode" data-spark-agent-mode aria-label="SPARK thinking mode"><option value="fast">Low</option><option value="reasoning" selected>Reasoning</option><option value="deep">Deep</option></select>
    </div>
    <div data-spark-thinking-budget></div>
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
  let thinkingProfile;
  let thinkingScope;
  let thinkingSaved;
  let latestConfiguration;
  let operationRevision = 0;
  const budgetRoot = card.querySelector("[data-spark-thinking-budget]");
  budgetRoot.addEventListener("change", () => syncReasoningPreferenceField(budgetRoot, thinkingProfile));
  budgetRoot.addEventListener("click", (event) => {
    if (busy || !event.target.matches("[data-spark-save-thinking]")) return;
    void perform(() => onReasoningPreferenceChange(readReasoningPreferenceField(budgetRoot)), "Thinking preference saved for the next message.");
  });
  function controls() {
    select.disabled = busy || !ready;
    agentModeSelect.disabled = busy || !ready || !reasoningEnabled;
    save.disabled = busy || !ready || select.value === saved;
    clear.disabled = busy || !ready;
    for (const selector of ["select", "button"])
      for (const field of budgetRoot.querySelectorAll(selector)) field.disabled = busy || !ready;
    const input = budgetRoot.querySelector("[data-reasoning-budget]");
    if (input) input.disabled = busy || !ready || budgetRoot.querySelector("[data-reasoning-preference-mode]")?.value !== "budget";
  }
  async function perform(action, successMessage = "") {
    const environment = environmentId;
    const revision = ++operationRevision;
    busy = true; feedback.textContent = ""; controls();
    try {
      await action();
      if (environment !== environmentId || revision !== operationRevision) return;
      feedback.textContent = successMessage;
      render(latestConfiguration, environmentId);
    }
    catch (error) {
      if (environment !== environmentId || revision !== operationRevision) return;
      render(latestConfiguration, environmentId);
      feedback.textContent = error.code === "spark_chat_busy"
        ? "Stop the active request or resolve its approval before clearing SPARK chat."
        : error.message;
    }
    finally { if (environment === environmentId && revision === operationRevision) { busy = false; controls(); } }
  }
  select.addEventListener("change", controls);
  agentModeSelect.addEventListener("change", () => {
    if (busy || !reasoningEnabled || !agentModeSelect.value) return;
    void perform(() => onAgentModeChange(agentModeSelect.value), "Reasoning mode selected.");
  });
  card.querySelector("form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (save.disabled) return;
    const mode = select.value;
    void perform(() => onSave(mode), "Permissions saved.");
  });
  clear.addEventListener("click", async () => {
    if (clear.disabled) return;
    const environment = environmentId;
    const sessionId = latestConfiguration?.sessionId;
    const revision = operationRevision;
    if (!await confirmClear("Clear all messages in the SPARK conversation? Long-term memory and permissions will be kept.")) return;
    if (environment !== environmentId || sessionId !== latestConfiguration?.sessionId) return;
    if (revision !== operationRevision || clear.disabled) return;
    await perform(onClear);
  });
  card.querySelector("[data-spark-open]").addEventListener("click", onOpen);
  card.querySelector("[data-spark-reset-position]").addEventListener("click", () => onResetPosition?.());
  card.querySelector("[data-spark-model-settings]").addEventListener("click", () => onOpenModelSettings?.());
  function render(configuration, nextEnvironmentId) {
      latestConfiguration = configuration;
      if (environmentId !== nextEnvironmentId) {
        environmentId = nextEnvironmentId; busy = false; ready = false; feedback.textContent = "";
        select.value = configuration?.toolPermissionMode || "ask";
      }
      reasoningEnabled = canChooseReasoning(configuration);
      thinkingProfile = { ...configuration, id: configuration?.modelProfileId };
      const preference = getReasoningPreference();
      const budgetAvailable = canChooseReasoningBudget(thinkingProfile);
      const nextThinkingScope = JSON.stringify([nextEnvironmentId, configuration?.sessionId, configuration?.modelProfileId, budgetAvailable]);
      const nextThinkingSaved = JSON.stringify(preference);
      if (thinkingScope !== nextThinkingScope) { operationRevision += 1; busy = false; }
      if (thinkingScope !== nextThinkingScope || thinkingSaved !== nextThinkingSaved) {
        budgetRoot.innerHTML = budgetAvailable || preference
          ? `${renderReasoningPreferenceField(thinkingProfile, preference)}<button type="button" data-spark-save-thinking>Apply to next message</button>` : "";
        thinkingScope = nextThinkingScope; thinkingSaved = nextThinkingSaved;
      }
      agentModeSelect.innerHTML = reasoningModeOptions(getAgentMode(), reasoningEnabled);
      agentModeSelect.title = reasoningEnabled ? "Reasoning depth" : "Enable reasoning controls for this model in Models.";
      const next = configuration?.toolPermissionMode || "ask";
      if (!ready || select.value === saved || busy) select.value = next;
      saved = next; ready = Boolean(configuration?.sessionId);
      select.querySelector('[value="full_plus"]').disabled = !supportsFullPlus(getWebConfig());
      controls();
  }
  return { render };
}
