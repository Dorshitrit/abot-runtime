// Retain an unchanged region and preserve its view state when content changes.
const renderedRegions = new WeakMap();
const identityAttributes = [
  "id",
  "data-session-id",
  "data-request-id",
  "data-job-id",
  "data-run-id",
  "data-disclosure-id",
  "data-dashboard-action",
  "data-template-id",
  "data-job-action",
  "data-run-page",
  "data-open-request",
  "data-open-conversation",
  "data-state-action",
];

function nodePath(root, node) {
  if (!node || !root.contains(node)) return null;
  const path = [];
  while (node !== root) {
    const parent = node.parentElement;
    path.unshift({
      tag: node.tagName,
      index: [...parent.children].indexOf(node),
      identity: identityAttributes
        .filter((name) => node.hasAttribute(name))
        .map((name) => [name, node.getAttribute(name)]),
    });
    node = parent;
  }
  return path;
}

function matchesNodeIdentity(node, segment) {
  if (node.tagName !== segment.tag) return false;
  return segment.identity.every(
    ([name, value]) => node.getAttribute(name) === value,
  );
}

function resolveNodePath(root, path) {
  if (!path) return null;
  let node = root;
  for (const segment of path) {
    const children = [...node.children];
    const candidate = segment.identity.length
      ? children.find((child) => matchesNodeIdentity(child, segment))
      : children[segment.index];
    if (!candidate || candidate.tagName !== segment.tag) return null;
    node = candidate;
  }
  return node;
}

function captureViewState(root) {
  return {
    focus: nodePath(root, root.ownerDocument.activeElement),
    open: [...root.querySelectorAll("details[open]")].map((node) =>
      nodePath(root, node),
    ),
    scroll: [root, ...root.querySelectorAll("*")]
      .filter((node) => node.scrollTop || node.scrollLeft)
      .map((node) => ({
        path: nodePath(root, node),
        top: node.scrollTop,
        left: node.scrollLeft,
      })),
  };
}

function restoreViewState(root, state) {
  for (const path of state.open) {
    const node = resolveNodePath(root, path);
    if (node) node.open = true;
  }
  resolveNodePath(root, state.focus)?.focus({ preventScroll: true });
  for (const position of state.scroll) {
    const node = resolveNodePath(root, position.path);
    if (!node) continue;
    node.scrollTop = position.top;
    node.scrollLeft = position.left;
  }
}

export function updateLiveRegion(root, markup) {
  const previous = renderedRegions.get(root);
  const ownsCurrentNodes = previous?.firstChild === root.firstChild;
  if (ownsCurrentNodes && previous?.markup === markup) return false;
  const state = previous && ownsCurrentNodes ? captureViewState(root) : null;
  root.innerHTML = markup;
  renderedRegions.set(root, { markup, firstChild: root.firstChild });
  if (state) restoreViewState(root, state);
  return true;
}
