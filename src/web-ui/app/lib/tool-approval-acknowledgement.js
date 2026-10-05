/** Socket acknowledgements belong to the view that submitted that exact decision. */
export function ownsToolApprovalAcknowledgement(message, state, environmentId) {
  const messageEnvironment = message.environmentId || message.environment;
  if (messageEnvironment && messageEnvironment !== environmentId) return false;
  if (message.sessionId && message.sessionId !== state.currentSessionId) return false;
  return state.submittedToolApprovalIds.has(message.approvalId);
}
