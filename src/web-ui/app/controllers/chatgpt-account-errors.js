function isChatgptLocalConnectionError(error) {
  return error?.code === "chatgpt_local_only";
}

/** Expose supported account errors without rendering arbitrary server details. */
export function chatgptAccountErrorMessage(error, fallback) {
  if (isChatgptLocalConnectionError(error))
    return "ChatGPT sign-in requires a direct local connection to ABot or a trusted Docker Web UI published on loopback.";
  return fallback;
}
