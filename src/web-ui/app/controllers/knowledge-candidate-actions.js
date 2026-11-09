/** User-owned candidate actions shared by Knowledge and native HOME widgets. */
export function createKnowledgeCandidateActions({ client, getEnvironmentId, getCandidates,
  isRuntimeReady = () => true, onChange = () => {}, onCommitted = () => {} }) {
  let epoch = 0;
  let state = emptyCandidateActionState();
  const snapshot = () => ({ ...state });

  function hasCurrentCandidateBinding(binding) {
    if (!isRuntimeReady() || state.pendingCandidateId) return false;
    if (binding.environmentId !== getEnvironmentId()) return false;
    return getCandidates().some(candidate => candidate.id === binding.id && candidate.revision === binding.revision);
  }

  async function mutateCandidate(action, binding) {
    if (!hasCurrentCandidateBinding(binding)) return;
    const operationEpoch = epoch;
    function hasCurrentCandidateOperation() {
      if (operationEpoch !== epoch) return false;
      return binding.environmentId === getEnvironmentId();
    }
    state = { pendingCandidateId: binding.id, pendingCandidateAction: action, candidateActionError: "" };
    onChange();
    try {
      const method = action === "promote" ? client.promoteLearningCandidate : client.deleteLearningCandidate;
      if (typeof method !== "function") throw new Error("long_term_memory_unavailable");
      const result = await method.call(client, binding);
      if (!hasCurrentCandidateOperation()) return;
      if (!hasConfirmedCandidateMutation(action, result)) throw new Error("Candidate change was not confirmed. Refresh and try again.");
      try { await onCommitted({ ...binding, action, result }); }
      catch {
        if (hasCurrentCandidateOperation()) state.candidateActionError = "The change was saved, but the list could not be refreshed.";
      }
      return result;
    } catch (error) {
      if (hasCurrentCandidateOperation()) state.candidateActionError = candidateActionFailure(error);
    } finally {
      if (hasCurrentCandidateOperation()) {
        state.pendingCandidateId = "";
        state.pendingCandidateAction = "";
        onChange();
      }
    }
  }

  return Object.freeze({ snapshot,
    promoteCandidate: binding => mutateCandidate("promote", binding),
    deleteCandidate: binding => mutateCandidate("delete", binding),
    reset() { epoch += 1; state = emptyCandidateActionState(); },
  });
}

function emptyCandidateActionState() {
  return { pendingCandidateId: "", pendingCandidateAction: "", candidateActionError: "" };
}

function hasConfirmedCandidateMutation(action, result) {
  if (action === "delete") return result?.deleted === true;
  return typeof result?.record?.id === "string" && result.record.id.length > 0;
}

function candidateActionFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("management_conflict")) return "This candidate or its memory changed. Refresh before deciding again.";
  if (message.includes("management_not_found")) return "This candidate or its memory is no longer available. Refresh to see the current list.";
  if (message.includes("management_duplicate")) return "This content is already saved as a memory. You can delete the candidate.";
  if (message.includes("memory_disabled")) return "Enable memory before saving this candidate.";
  if (message.includes("management_sensitive_data")) return "This candidate contains sensitive data and cannot be saved as memory.";
  return "The candidate could not be changed. Refresh and try again.";
}
