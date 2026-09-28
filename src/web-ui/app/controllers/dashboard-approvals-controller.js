function approvalIdentity(approval) {
  return JSON.stringify([
    approval.environmentId,
    approval.sessionId,
    approval.requestId,
    approval.approvalId,
  ]);
}

export function createDashboardApprovalsController({
  client,
  getEnvironmentId,
  render,
}) {
  let approvals = [];
  let environmentId = "";
  let loading = true;
  let settled = false;
  let error = "";
  let decisionError = "";
  let scopeRevision = 0;
  let readRevision = 0;
  const submitting = new Set();

  function snapshot() {
    return {
      approvals:
        environmentId === getEnvironmentId()
          ? approvals.map((approval) => ({
              ...approval,
              submitted: submitting.has(approvalIdentity(approval)),
            }))
          : [],
      supportsToolApprovals: client.supportsToolApprovals(),
      loadingApprovals: loading,
      approvalsError: error,
      approvalDecisionError: decisionError,
    };
  }

  function hasCurrentScope(scope, revision) {
    if (scope !== getEnvironmentId()) return false;
    return revision === scopeRevision;
  }

  function hasCurrentRead(scope, revision) {
    if (scope !== getEnvironmentId()) return false;
    return revision === readRevision;
  }

  function invalidate() {
    scopeRevision += 1;
    readRevision += 1;
    environmentId = "";
    approvals = [];
    loading = true;
    settled = false;
    error = "";
    decisionError = "";
    submitting.clear();
  }

  async function refresh() {
    const scope = getEnvironmentId();
    if (!hasCurrentScope(environmentId, scopeRevision)) invalidate();
    const revision = ++readRevision;
    environmentId = scope;
    loading = !settled;
    if (!client.supportsToolApprovals()) {
      approvals = [];
      loading = false;
      settled = true;
      error = "";
      render();
      return;
    }
    render();
    try {
      const result = await client.listToolApprovals(scope);
      if (!hasCurrentRead(scope, revision)) return;
      approvals = result.approvals;
      error = "";
    } catch (failure) {
      if (!hasCurrentRead(scope, revision)) return;
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      if (hasCurrentRead(scope, revision)) {
        loading = false;
        settled = true;
        render();
      }
    }
  }

  function canSubmitApproval(approval, identity) {
    if (!client.supportsToolApprovals()) return false;
    if (approval.environmentId !== getEnvironmentId()) return false;
    if (submitting.has(identity)) return false;
    return approvals.some((pending) => approvalIdentity(pending) === identity);
  }

  async function submit(approval, approved) {
    const identity = approvalIdentity(approval);
    if (!canSubmitApproval(approval, identity)) return false;
    const scope = approval.environmentId;
    const revision = scopeRevision;
    submitting.add(identity);
    decisionError = "";
    render();
    try {
      await client.decideToolApproval({
        environmentId: scope,
        sessionId: approval.sessionId,
        requestId: approval.requestId,
        approvalId: approval.approvalId,
        approved,
        ...approvalDecisionCommand(approval, approved),
      });
      if (!hasCurrentScope(scope, revision)) return true;
      approvals = approvals.filter(
        (pending) => approvalIdentity(pending) !== identity,
      );
      await refresh();
      return true;
    } catch (failure) {
      if (!hasCurrentScope(scope, revision)) return false;
      decisionError =
        failure instanceof Error ? failure.message : String(failure);
      await refresh();
      return false;
    } finally {
      if (hasCurrentScope(scope, revision)) {
        submitting.delete(identity);
        render();
      }
    }
  }

  return { snapshot, refresh, invalidate, submit };
}
import { approvalDecisionCommand } from "../lib/approval-decision-command.js";
