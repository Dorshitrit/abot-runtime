export function isStopResult(message) {
  return (message?.error ?? message?.payload?.error) === "request_cancelled";
}

export function isStoppedRequest(request) {
  return (
    request?.status === "failed" &&
    (isStopResult(request.finalState) ||
      request.events?.some(isStopResult) === true)
  );
}

export function stoppedResponseText(partial = "", terminal) {
  const persisted = terminal?.details?.stoppedResponse;
  if (typeof persisted === "string" && persisted.trim()) return persisted;
  return partial.trim()
    ? `${partial}\n\n_Response stopped._`
    : "Response stopped.";
}

export function restoreStoppedResponses(messages, requests) {
  for (const request of requests) {
    if (!isStoppedRequest(request)) continue;
    if (
      messages.some(
        (message) =>
          message.role === "assistant" &&
          message.kind !== "tool_approval_request" &&
          message.requestId === request.requestId,
      )
    )
      continue;
    const tokens = (request.events ?? []).filter((entry) => {
      const event = entry.payload ?? entry;
      return (event.name ?? event.type) === "token";
    });
    // Persisted runtime token events contain the accumulated answer, not deltas.
    const lastToken = tokens.at(-1);
    const partial = String((lastToken?.payload ?? lastToken)?.text ?? "");
    const after = messages.findLastIndex(
      (message) => message.requestId === request.requestId,
    );
    const response = {
      id: `stopped-${request.requestId}`,
      role: "assistant",
      requestId: request.requestId,
      text: stoppedResponseText(partial),
      createdAt: request.updatedAt,
      streaming: false,
    };
    messages.splice(after < 0 ? messages.length : after + 1, 0, response);
  }
}
