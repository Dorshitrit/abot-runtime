/** Apply explicit pin actions in order, publishing only acknowledged values. */
export function createSessionPinUpdates({ state, preferences }) {
  let pending = Promise.resolve();
  return function updatePinnedSessions(change) {
    const saving = pending.then(async () => {
      const next = change(state.pinnedSessionIds);
      await preferences.savePinnedSessions(next);
      state.pinnedSessionIds = next;
    });
    // A rejected action must not prevent a later explicit action from settling.
    pending = saving.catch(() => {});
    return saving;
  };
}
