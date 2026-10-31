// Official, unmodified asset: https://developers.openai.com/assets/siwc/chatgpt-logo-white.svg
export function renderChatgptLogo() {
  return '<img class="chatgpt-logo" src="/chatgpt-logo-white.svg" width="21" height="21" alt="" aria-hidden="true" />';
}
export function renderChatgptSignInButton(disabled = false) {
  return `<button type="button" class="chatgpt-sign-in" data-chatgpt-action="sign-in" ${disabled ? "disabled" : ""}>${renderChatgptLogo()}<span>Continue with ChatGPT</span></button>`;
}
