import { isSessionReadStateUnavailable } from "../../lib/session-read-state.js";

function hasReadProposalConversation(proposal, sessions) {
  const session = sessions.find((item) => item.id === proposal.sessionId);
  if (!session || isSessionReadStateUnavailable(session)) return false;
  // Each proposal starts its own conversation. Any confirmed assistant read
  // boundary in that conversation includes the opening proposal.
  return Boolean(session.lastReadMessageId ?? session.readState?.lastReadMessageId);
}

/** Invitations reflect confirmed reads without changing the stored proposal history. */
export function visibleProposalSnapshot(snapshot, sessionSnapshot) {
  if (!snapshot.status?.proactive) return snapshot;
  if (!sessionSnapshot) return snapshot;
  if (sessionSnapshot.environmentId !== snapshot.environmentId) return snapshot;
  const proposals = (snapshot.status.proactive.proposals ?? []).filter(
    (proposal) => !hasReadProposalConversation(proposal, sessionSnapshot.sessions),
  );
  return {
    ...snapshot,
    status: { ...snapshot.status, proactive: { ...snapshot.status.proactive, proposals } },
  };
}
