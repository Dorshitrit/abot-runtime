/** Session opens and New conversation share the latest navigation intent. */
export function beginConversationNavigation(state) {
  const revision = (state.conversationNavigationRevision ?? 0) + 1;
  state.conversationNavigationRevision = revision;
  return () => state.conversationNavigationRevision === revision;
}

/** The selector may name a target whose recovered drafts are not saved yet. */
export function canNavigateConversation(state) {
  return hasCommittedConversationEnvironment(state);
}

export function hasCommittedConversationEnvironment(state) {
  return state.environmentChangePending !== true;
}
