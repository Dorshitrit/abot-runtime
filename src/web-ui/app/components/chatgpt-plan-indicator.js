import { CHATGPT_USAGE_URL } from "./chatgpt-accounts/rendering.js";
export function syncChatgptPlanIndicator({ anchor, documentRoot, usingPlan }) {
  const root = anchor.closest?.(".composer") ?? anchor.parentElement;
  if (!root) return;
  let note = root.querySelector?.(".chatgpt-plan-indicator");
  if (!note && !usingPlan) return;
  if (!note) {
    note = documentRoot.createElement("span");
    note.className = "chatgpt-plan-indicator";
    const text = documentRoot.createElement("span");
    text.textContent = "Using ChatGPT plan";
    const usage = documentRoot.createElement("a");
    usage.href = CHATGPT_USAGE_URL;
    usage.target = "_blank";
    usage.rel = "noopener noreferrer";
    usage.textContent = "Manage usage";
    note.append(text, usage);
    root.append(note);
  }
  note.hidden = !usingPlan;
}
