const rejectionControls = new WeakMap();

function canSendRejection(draft, submitted) {
  if (submitted) return false;
  return Boolean(draft.text.trim());
}

/** Frame only text authored through this action; existing rejection reasons stay intact. */
function userRejectionReason(text) {
  return "The user rejected this action. User explanation:\n" + text.trim();
}

export function createToolApprovalRejectionInput({
  draft,
  submitted,
  onReject,
  documentRoot,
}) {
  const open = documentRoot.createElement("button");
  open.type = "button";
  open.className = "tool-approval-button reject";
  open.textContent = "Reject with message";
  open.disabled = submitted;
  open.setAttribute("aria-expanded", String(draft.expanded));

  const editor = documentRoot.createElement("div");
  editor.className = "tool-approval-rejection-editor";
  editor.hidden = !draft.expanded;
  const label = documentRoot.createElement("label");
  label.className = "tool-approval-rejection-label";
  const title = documentRoot.createElement("span");
  title.textContent = "Why are you rejecting this action?";
  const input = documentRoot.createElement("textarea");
  input.className = "tool-approval-rejection-text";
  input.dir = "auto";
  input.rows = 3;
  input.value = draft.text;
  input.disabled = submitted;
  label.append(title, input);

  const controls = documentRoot.createElement("div");
  controls.className = "tool-approval-rejection-controls";
  const send = documentRoot.createElement("button");
  send.type = "button";
  send.className = "tool-approval-button reject";
  send.textContent = "Reject and send message";
  send.disabled = !canSendRejection(draft, submitted);
  const cancel = documentRoot.createElement("button");
  cancel.type = "button";
  cancel.className = "tool-approval-button";
  cancel.textContent = "Cancel";
  cancel.disabled = submitted;
  controls.append(send, cancel);
  editor.append(label, controls);
  for (const [kind, control] of Object.entries({ open, input, send, cancel })) {
    rejectionControls.set(control, { draft, kind });
  }

  open.addEventListener("click", () => {
    if (submitted) return;
    draft.expanded = true;
    editor.hidden = false;
    open.setAttribute("aria-expanded", "true");
    input.focus();
  });
  cancel.addEventListener("click", () => {
    if (submitted) return;
    draft.expanded = false;
    editor.hidden = true;
    open.setAttribute("aria-expanded", "false");
    open.focus();
  });
  input.addEventListener("input", () => {
    if (submitted) return;
    draft.text = input.value;
    send.disabled = !canSendRejection(draft, submitted);
  });
  send.addEventListener("click", () => {
    if (!canSendRejection(draft, submitted)) return;
    onReject(userRejectionReason(draft.text));
  });

  return { open, editor };
}

function canRestoreRejectionControl(control, kind, draft) {
  if (!control || control.disabled) return false;
  if (kind === "open") return true;
  return draft.expanded;
}

/** Capture this editor's focus before its owning view rebuilds the DOM. */
export function captureApprovalRejectionFocus(root, documentRoot) {
  const active = documentRoot?.activeElement;
  const focused = rejectionControls.get(active);
  if (!focused || !root.contains(active)) return () => {};
  const { draft, kind } = focused;
  const start = active.selectionStart;
  const end = active.selectionEnd;
  const direction = active.selectionDirection;
  const scrollTop = active.scrollTop;
  return () => {
    const control = [...root.querySelectorAll("button, textarea")].find(
      (candidate) => {
        const entry = rejectionControls.get(candidate);
        return entry?.draft === draft && entry.kind === kind;
      },
    );
    if (!canRestoreRejectionControl(control, kind, draft)) return;
    if (control === documentRoot.activeElement) return;
    control.focus({ preventScroll: true });
    if (kind !== "input") return;
    control.setSelectionRange(start, end, direction);
    control.scrollTop = scrollTop;
  };
}
