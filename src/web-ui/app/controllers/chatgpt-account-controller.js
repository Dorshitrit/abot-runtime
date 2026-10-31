import { chatgptAccountErrorMessage } from "./chatgpt-account-errors.js";

export function createChatgptAccountController({
  client, getEnvironmentId = () => "", onChange = () => {}, openAuthorization = () => {},
  schedule = setTimeout, unschedule = clearTimeout, now = Date.now,
}) {
  const state = { accounts: [], accountRef: "", models: [], busy: "", error: "", notice: "", attempt: null, loaded: false };
  let generation = 0;
  let environment = getEnvironmentId();
  let abort = null;
  let timer = null;

  function isCurrentAccountOperation(operation) {
    if (operation.generation !== generation) return false;
    return operation.environment === getEnvironmentId();
  }
  function begin(busy) {
    generation += 1;
    abort?.abort();
    if (timer !== null) unschedule(timer);
    timer = null;
    abort = new AbortController();
    environment = getEnvironmentId();
    state.busy = busy;
    state.error = "";
    state.notice = "";
    return { generation, environment, signal: abort.signal };
  }
  function reset() {
    generation += 1;
    abort?.abort();
    abort = null;
    if (timer !== null) unschedule(timer);
    timer = null;
    const attempt = state.attempt;
    if (attempt?.status === "pending") void client.cancelChatgptAttempt(attempt.attemptId).catch(() => {});
    Object.assign(state, { accounts: [], accountRef: "", models: [], busy: "", error: "", notice: "", attempt: null, loaded: false });
    environment = getEnvironmentId();
  }
  const account = () => state.accounts.find((entry) => entry.accountRef === state.accountRef) || null;
  function canUseAccount() {
    if (environment !== getEnvironmentId()) return false;
    if (state.busy || state.attempt?.status === "pending") return false;
    const selected = account();
    return selected?.status === "connected" && selected.planEnabled === true;
  }
  async function readModels(operation) {
    state.models = [];
    const selected = account();
    if (selected?.status !== "connected" || !selected.planEnabled) return;
    const payload = await client.listChatgptModels(selected.accountRef, { signal: operation.signal });
    if (!isCurrentAccountOperation(operation) || selected.accountRef !== state.accountRef) return;
    state.models = payload.models;
  }
  async function load(preferredAccount = state.accountRef) {
    const operation = begin("loading");
    onChange();
    try {
      const payload = await client.listChatgptAccounts({ signal: operation.signal });
      if (!isCurrentAccountOperation(operation)) return;
      state.accounts = payload.accounts;
      state.accountRef = state.accounts.some((entry) => entry.accountRef === preferredAccount) ? preferredAccount : "";
      state.loaded = true;
      await readModels(operation);
    } catch (error) {
      if (isCurrentAccountOperation(operation)) state.error = chatgptAccountErrorMessage(error, "ChatGPT accounts could not be loaded. Try again.");
    } finally {
      if (isCurrentAccountOperation(operation)) {
        // A settled initial read must not restart when its error is rendered.
        state.loaded = true;
        state.busy = "";
        onChange();
      }
    }
  }
  async function select(accountRef) {
    if (state.busy || state.attempt?.status === "pending") return;
    if (!state.accounts.some((entry) => entry.accountRef === accountRef)) return;
    state.accountRef = accountRef;
    const operation = begin("models");
    state.models = [];
    onChange();
    try { await readModels(operation); }
    catch { if (isCurrentAccountOperation(operation)) state.error = "The model list could not be loaded. Try again."; }
    finally { if (isCurrentAccountOperation(operation)) { state.busy = ""; onChange(); } }
  }
  async function settleAttempt(operation, attempt) {
    if (!isCurrentAccountOperation(operation)) return;
    state.attempt = attempt;
    if (attempt.status === "complete") {
      state.busy = "";
      await load(attempt.accountRef);
      return;
    }
    if (attempt.status !== "pending") {
      state.busy = "";
      state.error = attempt.error?.message || (attempt.status === "failed" ? "ChatGPT sign-in could not be completed." : "");
      onChange();
      return;
    }
    if (attempt.expiresAt <= now()) {
      await cancel();
      state.error = "ChatGPT sign-in expired. Continue with ChatGPT to try again.";
      onChange();
      return;
    }
    onChange();
    timer = schedule(() => { timer = null; void poll(operation); }, 1000);
  }
  async function poll(operation) {
    if (!isCurrentAccountOperation(operation) || !state.attempt) return;
    try {
      const payload = await client.getChatgptAttempt(state.attempt.attemptId, { signal: operation.signal });
      await settleAttempt(operation, payload.attempt);
    } catch {
      if (!isCurrentAccountOperation(operation)) return;
      state.busy = "";
      state.error = "Sign-in status could not be checked. Cancel and try again.";
      onChange();
    }
  }
  async function authorize(request) {
    if (state.busy || state.attempt?.status === "pending") return;
    const operation = begin("signing_in");
    state.models = [];
    onChange();
    try {
      const payload = await request(operation.signal);
      if (!isCurrentAccountOperation(operation)) {
        if (payload.attempt?.status === "pending") void client.cancelChatgptAttempt(payload.attempt.attemptId).catch(() => {});
        return;
      }
      state.attempt = payload.attempt;
      if (payload.attempt.authorizationUrl) openAuthorization(payload.attempt.authorizationUrl);
      await settleAttempt(operation, payload.attempt);
    } catch (error) {
      if (!isCurrentAccountOperation(operation)) return;
      state.busy = "";
      state.error = chatgptAccountErrorMessage(error, "ChatGPT sign-in could not be started. Try again.");
      onChange();
    }
  }
  function start(purpose = "sign_in", accountRef = state.accountRef) {
    return authorize((signal) => client.startChatgptAttempt({ purpose, ...(accountRef ? { accountRef } : {}) }, { signal }));
  }
  function retry() {
    const attempt = state.attempt;
    if (attempt?.status !== "failed" || !attempt.retryable) return Promise.resolve();
    return authorize((signal) => client.retryChatgptAttempt(attempt.attemptId, { signal }));
  }
  async function cancel() {
    const attempt = state.attempt;
    const operation = begin("");
    state.attempt = null;
    onChange();
    if (!attempt) return;
    try { await client.cancelChatgptAttempt(attempt.attemptId); }
    catch { if (isCurrentAccountOperation(operation)) { state.error = "Sign-in cancellation could not be confirmed. The attempt will expire."; onChange(); } }
  }
  async function disconnect() {
    const selected = account();
    if (!selected || state.busy) return;
    const operation = begin("disconnecting");
    onChange();
    try {
      const payload = await client.disconnectChatgptAccount(selected.accountRef, { signal: operation.signal });
      if (!isCurrentAccountOperation(operation)) return;
      await load(selected.accountRef);
      if (environment !== getEnvironmentId()) return;
      if (payload.result?.revocationConfirmed === false) state.notice = "Signed out locally. Remote revocation was not confirmed; manage access in ChatGPT settings.";
      onChange();
    } catch {
      if (isCurrentAccountOperation(operation)) { state.busy = ""; state.error = "The account could not be disconnected. Try again."; onChange(); }
    }
  }
  async function acknowledge() {
    const selected = account();
    if (!selected || !selected.planEnabled || state.busy) return;
    const operation = begin("acknowledging");
    onChange();
    try {
      const payload = await client.acknowledgeChatgptPlan(selected.accountRef, { signal: operation.signal });
      if (!isCurrentAccountOperation(operation)) return;
      state.accounts = state.accounts.map((entry) => entry.accountRef === selected.accountRef ? payload.account : entry);
    } catch { if (isCurrentAccountOperation(operation)) state.error = "The confirmation could not be saved. Try again."; }
    finally { if (isCurrentAccountOperation(operation)) { state.busy = ""; onChange(); } }
  }
  return { state, account, canUseAccount, load, select, start, retry, cancel, disconnect, acknowledge, reset };
}
