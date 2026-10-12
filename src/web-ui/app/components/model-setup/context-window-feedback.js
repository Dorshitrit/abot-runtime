import { readSetupContextWindowFeedback } from "../runtime-setup/context-window-feedback.js";
import { MODEL_SETUP_ID } from "./rendering.js";

const CONTEXT_FIELD = '[data-runtime-setup-field="context-window"]';
const CONTEXT_ERROR_ID = `${MODEL_SETUP_ID}Error-context-window`;
const CONTEXT_HELP_ID = `${MODEL_SETUP_ID}Help-context-window`;

export function receiveModelContextWindowFeedback(state, error) {
  if (state.busy !== "saving" || state.saved) return false;
  if (error?.payload?.contextWindow?.profileId !== state.profileId)
    return false;
  const feedback = readSetupContextWindowFeedback(error);
  if (!feedback) return false;
  state.contextWindowFeedback = feedback;
  state.step = 1;
  state.error = "";
  return true;
}

/** Remove only this feedback; preserve the draft and its secret input element. */
export function clearModelContextWindowFeedback(state, form) {
  if (!state.contextWindowFeedback) return;
  state.contextWindowFeedback = null;
  const field = form.querySelector(CONTEXT_FIELD);
  field?.removeAttribute("aria-invalid");
  field?.setAttribute("aria-describedby", CONTEXT_HELP_ID);
  field?.setAttribute("min", "1");
  form.querySelector(`[id="${CONTEXT_ERROR_ID}"]`)?.remove();
}

export function renderModelContextWindowFeedback(state, form, restoreFocus) {
  const feedback = state.contextWindowFeedback;
  if (!feedback) return;
  const field = form.querySelector(CONTEXT_FIELD);
  if (!field) return;
  field.setAttribute("aria-invalid", "true");
  field.setAttribute(
    "aria-describedby",
    `${CONTEXT_HELP_ID} ${CONTEXT_ERROR_ID}`,
  );
  field.setAttribute("min", String(feedback.minimumTokens));
  let message = form.querySelector(`[id="${CONTEXT_ERROR_ID}"]`);
  if (!message) {
    message = form.ownerDocument.createElement("small");
    message.setAttribute("id", CONTEXT_ERROR_ID);
    message.setAttribute("class", "runtime-setup-feedback error");
    message.setAttribute("role", "alert");
    field.parentElement.append(message);
  }
  message.textContent = feedback.message;
  if (state.busy || state.step !== 1 || !restoreFocus) return;
  field.focus();
}
