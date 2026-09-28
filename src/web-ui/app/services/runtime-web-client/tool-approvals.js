function hasScopedApproval(approval, environmentId) {
  if (approval?.environmentId !== environmentId) return false;
  if (typeof approval.sessionId !== "string" || !approval.sessionId)
    return false;
  if (typeof approval.requestId !== "string" || !approval.requestId)
    return false;
  if (typeof approval.approvalId !== "string" || !approval.approvalId)
    return false;
  if (approval.event?.name !== "tool.approval.required") return false;
  if (approval.event.requestId !== approval.requestId) return false;
  return approval.event.approvalId === approval.approvalId;
}

export function createToolApprovalRequests({
  requestApi,
  getConfig,
  getEnvironmentId,
}) {
  const supportsToolApprovals = () => getConfig()?.backend === "runtime";

  async function listToolApprovals(environmentId = getEnvironmentId()) {
    if (!supportsToolApprovals())
      throw new Error("Home approvals are unavailable.");
    const result = await requestApi(
      `/chat/approvals?environment=${encodeURIComponent(environmentId)}`,
    );
    if (!Array.isArray(result?.approvals))
      throw new Error("Invalid approval list.");
    if (
      !result.approvals.every((approval) =>
        hasScopedApproval(approval, environmentId),
      )
    )
      throw new Error("Invalid approval identity.");
    return result;
  }

  async function decideToolApproval({
    environmentId,
    sessionId,
    requestId,
    approvalId,
    approved,
    generation,
    waitId,
    revision,
    commandId,
  }) {
    if (!supportsToolApprovals())
      throw new Error("Home approvals are unavailable.");
    const result = await requestApi(
      `/chat/approvals/${encodeURIComponent(approvalId)}`,
      {
        method: "POST",
        body: JSON.stringify({
          environment: environmentId,
          sessionId,
          requestId,
          approved,
          ...(waitId ? { generation, waitId, revision, commandId } : {}),
        }),
      },
    );
    if (result?.ok !== true || result.approvalId !== approvalId)
      throw new Error(
        "The approval decision could not be confirmed. Refresh before trying again.",
      );
    return result;
  }

  return { supportsToolApprovals, listToolApprovals, decideToolApproval };
}
