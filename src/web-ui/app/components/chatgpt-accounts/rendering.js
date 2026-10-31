import { renderChatgptSignInButton } from "./sign-in-button.js";
import { escapeAttribute, escapeHtml } from "../../lib/text-format.js";
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
export function chatgptAuthorizationUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin !== "https://auth.openai.com" || url.pathname !== "/api/accounts/authorize") return "";
    if (url.searchParams.has("id_token_hint")) return "";
    return url.href;
  } catch { return ""; }
}
function chatgptAccountStatus(account) {
  if (!account) return "Choose an account or add one.";
  if (account.status === "identity_only") return "Signed in · ChatGPT plan usage is not enabled";
  if (account.status === "reauth_required") return "Sign in again to use this account";
  if (account.status === "connected" && account.planEnabled) return "ChatGPT plan usage enabled";
  return "Signed out";
}
export function renderChatgptAccounts(state, { locked = false, models = true } = {}) {
  const selected = state.accounts.find((account) => account.accountRef === state.accountRef);
  const pending = state.attempt?.status === "pending";
  const busy = Boolean(state.busy || pending);
  const options = state.accounts.map((account) => `<option value="${escapeAttribute(account.accountRef)}" ${account.accountRef === state.accountRef ? "selected" : ""}>${escapeHtml(account.label)}${account.email ? " · " + escapeHtml(account.email) : ""}</option>`).join("");
  const status = chatgptAccountStatus(selected);
  const authorize = chatgptAuthorizationUrl(state.attempt?.authorizationUrl);
  return `<section class="chatgpt-accounts" aria-label="ChatGPT account">
    <p>Use your ChatGPT plan for eligible AI requests. Account credentials stay on this computer.</p>
    <label class="runtime-setup-field"><span>ChatGPT account</span><select data-chatgpt-field="account" ${busy || locked ? "disabled" : ""}><option value="">Choose an account</option>${options}</select></label>
    <p class="runtime-setup-feedback">${escapeHtml(status)}</p>
    <div class="chatgpt-account-actions">
      ${renderChatgptSignInButton(busy)}
      ${!locked && selected ? `<button type="button" class="chatgpt-account-button" data-chatgpt-action="add" ${busy ? "disabled" : ""}>Add another account</button>` : ""}
      ${selected?.status === "identity_only" ? `<button type="button" class="chatgpt-account-button" data-chatgpt-action="enable" ${busy ? "disabled" : ""}>Enable ChatGPT plan usage</button>` : ""}
    </div>
    <div class="chatgpt-account-utilities">
      <a class="chatgpt-account-button" href="${CHATGPT_USAGE_URL}" target="_blank" rel="noopener noreferrer">Manage usage</a>
      ${selected && selected.status !== "signed_out" ? `<button type="button" class="chatgpt-account-button chatgpt-account-disconnect" data-chatgpt-action="disconnect" ${busy ? "disabled" : ""}>Disconnect</button>` : ""}
    </div>
    ${pending ? `<p role="status">Finish signing in in your browser.</p>${authorize ? `<a href="${escapeAttribute(authorize)}" target="_blank" rel="noopener noreferrer">Open ChatGPT sign-in</a>` : ""}<button type="button" class="chatgpt-account-button" data-chatgpt-action="cancel">Cancel sign-in</button>` : ""}
    ${state.attempt?.status === "failed" && state.attempt.retryable ? `<button type="button" class="chatgpt-account-button" data-chatgpt-action="retry" ${busy ? "disabled" : ""}>Retry sign-in</button>` : ""}
    ${state.error ? `<p class="runtime-setup-feedback error" role="alert">${escapeHtml(state.error)}</p><button type="button" class="chatgpt-account-button" data-chatgpt-action="reload" ${busy ? "disabled" : ""}>Try again</button>` : ""}
    ${state.notice ? `<p role="status">${escapeHtml(state.notice)}</p>` : ""}
    ${state.busy && !pending ? '<p role="status">Updating ChatGPT connection…</p>' : ""}
    ${models && selected?.planEnabled ? `<label class="runtime-setup-field"><span>Available models</span><select data-chatgpt-field="model" ${busy || !state.models.length ? "disabled" : ""}><option value="">Choose a model</option>${state.models.map((model) => `<option value="${escapeAttribute(model.id)}">${escapeHtml(model.displayName || model.id)}</option>`).join("")}</select><small>This list shows visibility for this account. It does not verify model capacity or settings.</small></label>` : ""}
  </section>`;
}
