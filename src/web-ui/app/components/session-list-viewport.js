const positions = new WeakMap();

function isSessionListVisible(root) {
  if (!root) return false;
  return root.getClientRects?.().length !== 0;
}

function captureSessionListFocus(root) {
  const focusedElement = root.ownerDocument?.activeElement;
  if (!root.contains?.(focusedElement)) return null;
  return focusedElement;
}

function canRestoreSessionListFocus(root, focusedElement) {
  if (!focusedElement) return false;
  if (!root.contains?.(focusedElement)) return false;
  if (focusedElement.getClientRects?.().length === 0) return false;
  const activeElement = root.ownerDocument?.activeElement;
  if (activeElement === focusedElement) return false;
  if (!activeElement) return true;
  return activeElement === root.ownerDocument?.body;
}

export function captureSessionListViewport(root, scope) {
  if (!root) return;
  const previous = positions.get(root);
  if (scope !== undefined && previous?.scope !== scope) {
    positions.set(root, { scope, scrollTop: 0 });
    return;
  }
  if (!isSessionListVisible(root)) return;
  positions.set(root, {
    scope: previous?.scope,
    scrollTop: Number(root.scrollTop) || 0,
    focusedElement: captureSessionListFocus(root),
  });
}

export function restoreSessionListViewport(root) {
  const position = positions.get(root);
  if (!position) return;
  const focusedElement = position.focusedElement;
  delete position.focusedElement;
  if (!isSessionListVisible(root)) return;
  if (canRestoreSessionListFocus(root, focusedElement)) {
    focusedElement.focus({ preventScroll: true });
  }
  root.scrollTop = position.scrollTop;
}
