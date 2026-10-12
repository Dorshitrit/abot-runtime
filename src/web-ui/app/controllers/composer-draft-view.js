/** Binds a textarea to one draft handle; changing the view never disposes a draft. */
export function createComposerDraftView({ input, getDraft, isVisible = () => true }) {
  let displayed = null;
  const parkedStyle = { height: "" };

  function saveDisplayed() {
    if (displayed) displayed.text = input.value;
  }

  function display() {
    const next = getDraft();
    if (next !== displayed) {
      saveDisplayed();
      displayed = next;
      input.value = next.text;
    }
    return next;
  }

  function current() {
    const draft = getDraft();
    if (displayed === draft) draft.text = input.value;
    return draft;
  }

  const surface = {
    get value() { return current().text; },
    set value(value) {
      const draft = getDraft();
      draft.text = value;
      if (displayed === draft) input.value = draft.text;
    },
    get style() { return isVisible() ? input.style : parkedStyle; },
    get scrollHeight() { return isVisible() ? input.scrollHeight : 0; },
    focus() { if (isVisible()) input.focus(); },
  };

  input.addEventListener?.("input", saveDisplayed);

  return {
    surface, current, display, saveDisplayed,
    refresh(draft) {
      if (displayed !== draft) return;
      input.value = draft.text;
    },
    detach() { saveDisplayed(); displayed = null; },
  };
}
