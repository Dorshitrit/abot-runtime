/** Window-local drafts belong to the exact action, never to a conversation outbox. */
export function approvalRejectionIdentity(approval) {
  return JSON.stringify([
    approval.environmentId,
    approval.sessionId,
    approval.requestId,
    approval.approvalId,
    approval.generation,
    approval.waitId,
  ]);
}

export function createApprovalRejectionDrafts() {
  const drafts = new Map();

  function get(approval) {
    const key = approvalRejectionIdentity(approval);
    if (!drafts.has(key)) drafts.set(key, { text: "", expanded: false });
    return drafts.get(key);
  }

  function promoteBoundApprovalDraft(approval) {
    const key = approvalRejectionIdentity(approval);
    if (drafts.has(key)) return;
    const liveKey = approvalRejectionIdentity({
      ...approval,
      generation: undefined,
      waitId: undefined,
    });
    const liveDraft = drafts.get(liveKey);
    if (!liveDraft) return;
    drafts.set(key, liveDraft);
    drafts.delete(liveKey);
  }

  function retain(approvals) {
    for (const approval of approvals) promoteBoundApprovalDraft(approval);
    const pending = new Set(approvals.map(approvalRejectionIdentity));
    for (const key of drafts.keys()) {
      if (!pending.has(key)) drafts.delete(key);
    }
  }

  return { get, retain, clear: () => drafts.clear() };
}
