import { escapeHtml as html } from "../../lib/text-format.js";
import { AGENT_BUDGETS, agentDraftLimits } from "./onboarding-options.js";
import { agentBudgetContext, createAgentBudgetSelection, invalidAgentBudget } from "./agent-budgets.js";
import { budgetFields } from "./onboarding.js";
export function isStandaloneAgentConversation(detail) {
  if (typeof detail?.standaloneConversation === "boolean") return detail.standaloneConversation;
  const missionId = detail?.mission?.id;
  if (!missionId) return false;
  const origin = detail.messages?.find((message) => message.missionId === missionId);
  return origin?.role === "user" && origin.purpose === "conversation";
}

export function isPausedAgentTask(detail) {
  return detail?.status === "awaiting_user_decision" && !detail.pendingUserQuestionId && !isStandaloneAgentConversation(detail);
}

export function pausedAgentChatBlock(detail) {
  if (detail?.recovery?.budgetStopping) return "The work session is stopping. Wait for its final status before sending another message.";
  if (detail?.status !== "awaiting_user_decision" || detail.pendingUserQuestionId) return null;
  if (detail.recovery && "pausedChatBlock" in detail.recovery) return detail.recovery.pausedChatBlock;
  if (isStandaloneAgentConversation(detail)) return "Use Continue conversation to review the previous reply first.";
  return requiresAgentRecoveryBudget(detail) ? "The previous outcome or cost is unknown. Review the task before sending another message." : null;
}

function recoveryPrompt(state) {
  if (state.conversation) {
    return state.unknown ? "The previous reply has an unknown outcome or cost. Choose a new budget and enter the message to send."
      : "Enter a message to continue this conversation.";
  }
  if (state.unknown) return "The previous outcome and cost are unknown. Review the work sessions and choose a new budget to continue.";
  if (state.action === "steer") return "Update the current goal. The agent keeps its session history and remaining task budget.";
  return "Add your answer or decision so your agent can continue within the current task budget.";
}

function recoveryActionLabel(state) {
  if (state.busy) return "Saving…";
  if (state.conversation) return state.unknown ? "Authorize new reply" : "Continue conversation";
  if (state.unknown) return "Authorize new work";
  return state.action === "steer" ? "Update task" : "Continue task";
}

export function requiresAgentRecoveryBudget(detail) {
  if (detail.recovery?.requiresNewBudget !== undefined) return detail.recovery.requiresNewBudget === true;
  return detail.attempts?.some((attempt) => attempt.status === "unknown" && !attempt.userResolved) === true;
}
function readRecoveryDraft(saved, mission) {
  const emptyBudget = { budget: "", limits: {} };
  let snapshot;
  try { snapshot = JSON.parse(saved.onboarding || "null"); } catch { /* Older drafts can be text-only. */ }
  if (!snapshot?.missionId) return { ...emptyBudget, text: saved.text || "" };
  if (snapshot.missionId !== mission?.id || snapshot.missionRevision !== mission.revision) return { ...emptyBudget, text: "" };
  if (!Object.hasOwn(AGENT_BUDGETS, snapshot.budget) || !snapshot.limits || typeof snapshot.limits !== "object") {
    return { ...emptyBudget, text: saved.text || "" };
  }
  return { budget: snapshot.budget, limits: { ...snapshot.limits }, budgetPresetVersion: snapshot.budgetPresetVersion, text: saved.text || "" };
}

export function createAgentRecovery({ client, view, drafts, getScope, act }) {
  let state = null;
  const selection = createAgentBudgetSelection(client);
  const draftKey = () => `${state.selected}:${state.action}`;
  function render() {
    const panel = view.query("[data-agents-recovery]"); panel.hidden = !state;
    if (!state) return;
    const budgetLabel = state.conversation ? "New conversation budget" : "New task budget";
    const messageLabel = state.conversation ? "Your message" : state.action === "steer" ? "Updated task" : "Your answer";
    panel.innerHTML = `<form data-agents-form="recovery">
      <p>${recoveryPrompt(state)}</p>
      <label class="agents-label">${messageLabel}<textarea name="recoveryText" dir="auto" spellcheck="false" rows="2" required maxlength="4000">${html(state.text)}</textarea></label>
      ${state.unknown ? `<div class="agents-chips" role="group" aria-label="${budgetLabel}">${Object.entries(AGENT_BUDGETS).map(([key, value]) => `<button type="button" data-recovery-budget="${key}" aria-pressed="${state.budget === key}">${value.label}</button>`).join("")}</div>${budgetFields(state, state.budgetContext)}` : ""}
      <p class="agents-error">${html(state.error || "")}</p>
      <button type="submit" class="agents-primary" ${state.busy ? "disabled" : ""}>${recoveryActionLabel(state)}</button>
      <button type="button" class="agents-plain" data-agents-action="close-recovery">Keep waiting</button>
    </form>`;
  }
  async function persist() {
    if (!state) return;
    const { missionId, missionRevision, budget, limits, budgetPresetVersion } = state;
    await drafts.write(state.environment, draftKey(), { text: state.text, onboarding: JSON.stringify({ missionId, missionRevision, budget, limits, budgetPresetVersion }) });
  }
  return {
    isOpen: () => Boolean(state),
    sync(detail) {
      if (!state || state.busy) return;
      if (state.missionId === detail.mission?.id && state.missionRevision === detail.mission?.revision && detail.status === "awaiting_user_decision" && state.unknown === requiresAgentRecoveryBudget(detail)) return;
      selection.reset(); state = null; render();
    },
    open(detail, action = "resume") {
      selection.reset();
      const scope = getScope();
      const saved = drafts.read(scope.environment, `${scope.selected}:${action}`);
      state = { ...scope, ...readRecoveryDraft(saved, detail.mission), missionId: detail.mission?.id, missionRevision: detail.mission?.revision,
        action, conversation: isStandaloneAgentConversation(detail), unknown: requiresAgentRecoveryBudget(detail),
        budgetContext: agentBudgetContext(detail.agent?.definition), error: "" };
      render(); view.query('textarea[name="recoveryText"]').focus();
    },
    async change(target) { if (!state) return; if (target.name === "recoveryText") state.text = target.value; if (target.name.startsWith("limit:")) state.limits[target.name.slice(6)] = target.value; await persist(); },
    async choose(budget) {
      if (!state || state.busy || !Object.hasOwn(AGENT_BUDGETS, budget)) return;
      const pending = state;
      const applied = await selection.choose(pending, budget, pending, persist, error => { pending.error = error.message; render(); });
      if (applied && pending === state) { pending.error = ""; render(); }
    },
    async submit() {
      const active = state;
      if (!active || active.busy || !await selection.settled()) return;
      if (active !== state || active.busy) return;
      if (!state.text.trim()) { state.error = "Add your decision before continuing."; render(); return; }
      if (state.unknown && (!Object.hasOwn(AGENT_BUDGETS, state.budget) || invalidAgentBudget(state))) {
        state.error = "Choose and review a new task budget."; render(); return;
      }
      const pending = state; state.busy = true; render();
      try {
        await persist();
        if (pending !== state || pending.environment !== getScope().environment || pending.selected !== getScope().selected) return;
        const accepted = await act(pending.action, pending.selected, { text: pending.text, ...(pending.unknown ? { limits: agentDraftLimits(pending) } : {}) });
        if (pending !== state) return;
        if (!accepted) { state.busy = false; render(); return; }
        await drafts.write(pending.environment, `${pending.selected}:${pending.action}`, {}); state = null; render();
      } catch (error) { if (pending === state) { state.busy = false; state.error = error.message; render(); } }
    },
    close() { selection.reset(); state = null; render(); },
  };
}
