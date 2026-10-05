function operationKey(operation) {
  return JSON.stringify([operation.toolName, operation.operationId, operation.contractVersion]);
}

export function requiresFullPlus(operation) {
  return operation?.permissionMode === "full_plus" || operation?.approval === "always";
}

export function selectedAutomationOperations(definition, catalog) {
  const requested = new Map();
  function visit(node) {
    if (node?.kind === "sequence") node.children?.forEach(visit);
    else if (node?.kind === "parallel") node.branches?.forEach(visit);
    else if (node?.kind === "tool") requested.set(operationKey(node.operation), node.operation);
    else if (node?.kind === "agent") node.tools?.forEach((item) =>
      requested.set(operationKey(item.operation), item.operation));
  }
  visit(definition?.body);
  const catalogEntries = Array.isArray(catalog?.grantableOperations)
    ? catalog.grantableOperations : catalog?.operations || [];
  const available = new Map(catalogEntries.map((item) => [operationKey(item), item]));
  const missing = [...requested.keys()].filter((key) => !available.has(key));
  const operations = [...requested.entries()].filter(([key]) => available.has(key))
    .map(([, reference]) => ({ ...reference }));
  const mode = operations.some((operation) => requiresFullPlus(available.get(operationKey(operation))))
    ? "full_plus" : "full_access";
  return { operations, mode, missing,
    details: operations.map((operation) => available.get(operationKey(operation))),
  };
}

export function matchesAutomationGrant(grant, selection) {
  if (!grant || grant.mode !== selection.mode) return false;
  const current = (grant.operations || []).map(operationKey).sort();
  const needed = selection.operations.map(operationKey).sort();
  return current.length === needed.length && current.every((key, index) => key === needed[index]);
}
