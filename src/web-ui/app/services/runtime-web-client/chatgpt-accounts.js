/** ChatGPT credentials stay in the local Runtime; this transport handles public account receipts only. */
export function createChatgptAccountRequests({ requestApi, getConfig }) {
  const supportsChatgptAccounts = () => getConfig()?.backend === "runtime";
  function request(path, { signal, method = "GET", body } = {}) {
    if (!supportsChatgptAccounts()) throw new Error("ChatGPT sign-in requires the local Runtime.");
    return requestApi("/runtime/chatgpt/" + path, { method, signal, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  const accountPath = (accountRef) => "accounts/" + encodeURIComponent(accountRef);
  return {
    supportsChatgptAccounts,
    listChatgptAccounts: (options) => request("accounts", options),
    startChatgptAttempt: (input, options) => request("attempts", { ...options, method: "POST", body: input }),
    retryChatgptAttempt: (attemptId, options) => request("attempts/" + encodeURIComponent(attemptId) + "/retry", { ...options, method: "POST", body: {} }),
    getChatgptAttempt: (attemptId, options) => request("attempts/" + encodeURIComponent(attemptId), options),
    cancelChatgptAttempt: (attemptId) => request("attempts/" + encodeURIComponent(attemptId), { method: "DELETE", body: {} }),
    disconnectChatgptAccount: (accountRef, options) => request(accountPath(accountRef) + "/disconnect", { ...options, method: "POST", body: {} }),
    acknowledgeChatgptPlan: (accountRef, options) => request(accountPath(accountRef) + "/acknowledge-plan", { ...options, method: "POST", body: {} }),
    listChatgptModels: (accountRef, options) => request(accountPath(accountRef) + "/models", options),
  };
}
