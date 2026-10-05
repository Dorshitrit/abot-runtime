/** Lists only steps guaranteed to settle before the selected step. */
export function listAvailableAutomationProducers(body, selectedNodeId) {
  if (!body || !selectedNodeId) return [];

  function visitSequence(node, available) {
    let current = available;
    for (const child of Array.isArray(node.children) ? node.children : []) {
      const result = visit(child, current);
      if (result.found) return result;
      current = result.available;
    }
    return { found: false, available: current };
  }

  function visitParallel(node, available) {
    const joined = new Map(available);
    for (const branch of Array.isArray(node.branches) ? node.branches : []) {
      const result = visit(branch, available);
      if (result.found) return result;
      for (const [id, producer] of result.available) joined.set(id, producer);
    }
    joined.set(node.id, {
      id: node.id, kind: "parallel",
      title: `Parallel · ${node.branches?.length || 0} branches`,
    });
    return { found: false, available: joined };
  }

  function visit(node, available) {
    if (node?.kind === "sequence") return visitSequence(node, available);
    if (node?.kind === "parallel") return visitParallel(node, available);
    if (node?.id === selectedNodeId) return { found: true, available };
    if (node?.kind !== "agent" && node?.kind !== "tool")
      return { found: false, available };
    const settled = new Map(available);
    settled.set(node.id, { id: node.id, title: node.title, kind: node.kind });
    return { found: false, available: settled };
  }

  const result = visit(body, new Map());
  return result.found ? [...result.available.values()] : [];
}

export function hasConnectedAutomationResultInput(node) {
  return Object.values(node?.inputs || {}).some((binding) =>
    binding?.kind === "node_result" || binding?.kind === "branch_results");
}
