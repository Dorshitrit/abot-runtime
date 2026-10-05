// The runtime's nestingDepth of four permits two parallel groups on one path.
export const VALID_PARALLEL_LEVELS = 2;

function parallelAncestorCount(root, nodeId, ancestors = 0) {
  if (!root || !nodeId) return null;
  if (root.id === nodeId) return ancestors;
  const isParallel = root.kind === "parallel";
  const descendants = isParallel ? root.branches : root.children;
  for (const child of Array.isArray(descendants) ? descendants : []) {
    const found = parallelAncestorCount(child, nodeId, ancestors + Number(isParallel));
    if (found !== null) return found;
  }
  return null;
}

export function canWrapAutomationSequence(root, sequenceId) {
  const ancestors = parallelAncestorCount(root, sequenceId);
  return ancestors !== null && ancestors < VALID_PARALLEL_LEVELS;
}
