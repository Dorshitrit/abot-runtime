export function findAutomationPosition(root, nodeId) {
  if (!root || !nodeId) return null;
  if (root.kind === "sequence") {
    const children = Array.isArray(root.children) ? root.children : [];
    const index = children.findIndex((item) => item.id === nodeId);
    if (index >= 0) return { parentSequenceId: root.id, index, next: children[index + 1] || null, count: children.length };
    for (const child of children) {
      const found = findAutomationPosition(child, nodeId);
      if (found) return found;
    }
  }
  if (root.kind === "parallel") {
    for (const branch of Array.isArray(root.branches) ? root.branches : []) {
      const found = findAutomationPosition(branch, nodeId);
      if (found) return found;
    }
  }
  return null;
}
