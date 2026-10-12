function scopeKey(scope) {
  return JSON.stringify([scope.environmentId, scope.sessionId]);
}

function attachmentKey(attachment) {
  return JSON.stringify([attachment.environment, attachment.sessionId, attachment.storageRef, attachment.id]);
}

function combineAttachments(previous, current) {
  const files = new Map();
  for (const file of [...previous, ...current]) files.set(attachmentKey(file), file);
  return [...files.values()];
}

/** Window-lifetime drafts. DOM, navigation and requests borrow handles, not copies. */
export function createComposerDrafts() {
  const records = new Map();
  const listeners = new Set();

  function notify(draft) {
    for (const listener of listeners) listener(draft);
  }

  function open(scope) {
    const key = scopeKey(scope);
    const existing = records.get(key);
    if (existing) return existing;
    const identity = Object.freeze({ ...scope });
    let text = "";
    let files = [];
    let revision = 0;
    let generation = 0;
    let queueRelease = null;
    const uploads = new Map();
    const changed = () => { revision += 1; notify(draft); };
    const draft = {
      scope: identity,
      get text() { return text; },
      set text(value) {
        const next = String(value);
        if (text === next) return;
        text = next; changed();
      },
      get attachments() { return [...files]; },
      set attachments(value) { files = [...value]; changed(); },
      get revision() { return revision; },
      get generation() { return generation; },
      get release() { return queueRelease; },
      get uploading() { return uploads.get(generation) || 0; },
      isEmpty() { return !text && files.length === 0 && !queueRelease; },
      setRelease(release) { queueRelease = release; changed(); },
      startUpload() {
        const captured = generation;
        uploads.set(captured, (uploads.get(captured) || 0) + 1);
        notify(draft);
        return captured;
      },
      finishUpload(captured) {
        const count = (uploads.get(captured) || 0) - 1;
        if (count <= 0) uploads.delete(captured);
        else uploads.set(captured, count);
        notify(draft);
      },
      acceptUpload(captured, attachment) {
        if (captured !== generation) return false;
        files = combineAttachments(files, [attachment]);
        changed();
        return true;
      },
      snapshot() {
        return Object.freeze({ scope: identity, text, attachments: Object.freeze([...files]), release: queueRelease });
      },
      take() {
        const captured = draft.snapshot();
        text = "";
        files = [];
        queueRelease = null;
        generation += 1;
        changed();
        return captured;
      },
      restore(captured) {
        if (scopeKey(captured.scope) !== key) throw new Error("Cannot restore a draft into a different conversation.");
        if (captured.release && queueRelease && captured.release.releaseToken !== queueRelease.releaseToken)
          throw new Error("Another queued message already owns this draft.");
        text = text ? `${captured.text}\n${text}` : captured.text;
        files = combineAttachments(captured.attachments, files);
        queueRelease = captured.release ?? queueRelease;
        changed();
      },
      clearAttachments() {
        const removed = files;
        files = [];
        generation += 1;
        changed();
        return removed;
      },
      contains(attachment) { return files.some((file) => attachmentKey(file) === attachmentKey(attachment)); },
    };
    records.set(key, draft);
    return draft;
  }

  return {
    open,
    restore: (captured) => open(captured.scope).restore(captured),
    clearAttachments: (scope) => records.get(scopeKey(scope))?.clearAttachments() ?? [],
    assignSession(draft, sessionId) {
      if (draft.scope.sessionId) return draft;
      if (draft.uploading) throw new Error("Cannot assign a conversation while a file is uploading.");
      const target = open({ ...draft.scope, sessionId });
      const captured = draft.take();
      target.restore({ ...captured, scope: target.scope });
      records.delete(scopeKey(draft.scope));
      return target;
    },
    contains: (attachment) => [...records.values()].some((draft) => draft.contains(attachment)),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
