function matchesFileOpener(node, identity) {
  if (node.dataset.requestId !== identity.requestId) return false;
  return node.dataset.executionId === identity.executionId;
}

function isPreviewTabStop(node) {
  if (node.disabled || node.closest("[hidden]")) return false;
  const disclosure = node.closest("details");
  if (!disclosure || disclosure.open) return true;
  return node.tagName.toLowerCase() === "summary";
}

function isClosedDisclosure(node) {
  if (node.tagName.toLowerCase() !== "details") return false;
  return !node.open;
}

function isDisclosureSummary(node) {
  return node.tagName.toLowerCase() === "summary";
}

function visibleFileReturnTarget(node) {
  if (!node?.isConnected) return null;
  let target = node;
  for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.hidden || ancestor.inert) return null;
    if (!isClosedDisclosure(ancestor)) continue;
    const summary = [...ancestor.children].find(isDisclosureSummary);
    if (!summary) return null;
    if (!summary.contains(target)) target = summary;
  }
  return target;
}

function fileReturnTarget(node) {
  const target = visibleFileReturnTarget(node);
  if (target) return target;
  const activity = node?.closest(".conversation-activity");
  if (!activity) return null;
  const summary = [...activity.children].find(isDisclosureSummary);
  return visibleFileReturnTarget(summary);
}

export function createConversationFileFocus({
  panel,
  backdrop,
  host,
  closeButton,
  documentRoot,
  viewport,
  onClose,
}) {
  const overlayQuery = viewport.matchMedia?.("(max-width: 1200px)");
  const previewInertNodes = new Set();
  let open = false;
  let opener = null;
  let openerIdentity = null;

  function restoreBackground() {
    for (const element of previewInertNodes) {
      if (element.inert) element.inert = false;
    }
    previewInertNodes.clear();
  }

  function makeBackgroundInert() {
    for (let child = panel; child?.parentElement; child = child.parentElement) {
      for (const sibling of child.parentElement.children) {
        if (sibling === child || sibling === backdrop) continue;
        if (sibling.inert) continue;
        previewInertNodes.add(sibling);
        sibling.inert = true;
      }
      if (child.parentElement === documentRoot.body) break;
    }
  }

  function syncLayout() {
    restoreBackground();
    const modal = open && overlayQuery?.matches === true;
    backdrop.hidden = !modal;
    panel.classList.toggle("is-overlay", modal);
    if (!modal) {
      panel.removeAttribute("role");
      panel.removeAttribute("aria-modal");
      return;
    }
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    makeBackgroundInert();
    if (!panel.contains(documentRoot.activeElement)) closeButton.focus();
  }

  function findReturnTarget() {
    if (opener?.isConnected) return fileReturnTarget(opener);
    if (!openerIdentity) return null;
    const replacement = [
      ...host.querySelectorAll(".conversation-tool-file-action"),
    ].find((node) => matchesFileOpener(node, openerIdentity));
    return fileReturnTarget(replacement);
  }

  function show(nextOpener) {
    const wasOpen = open;
    open = true;
    if (nextOpener) {
      opener = nextOpener;
      openerIdentity = { ...nextOpener.dataset };
    }
    syncLayout();
    if (!wasOpen) closeButton.focus({ preventScroll: true });
  }

  function hide(restoreFocus) {
    const wasOpen = open;
    open = false;
    syncLayout();
    if (wasOpen && restoreFocus)
      findReturnTarget()?.focus({ preventScroll: true });
    opener = null;
    openerIdentity = null;
  }

  panel.addEventListener("keydown", (event) => {
    if (!open || event.key !== "Tab" || !overlayQuery?.matches) return;
    const elements = [
      ...panel.querySelectorAll("button, a[href], summary, [tabindex='0']"),
    ].filter(isPreviewTabStop);
    const first = elements[0];
    const last = elements.at(-1);
    const active = documentRoot.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last?.focus();
      return;
    }
    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first?.focus();
    }
  });
  documentRoot.addEventListener("keydown", (event) => {
    if (!open || event.key !== "Escape") return;
    event.preventDefault();
    onClose();
  });
  overlayQuery?.addEventListener("change", syncLayout);
  return { show, hide };
}
