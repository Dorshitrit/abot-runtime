import type { AutomationRevision, WorkflowNode } from "./definition-contracts.js";
import type { DraftMutation } from "./draft-mutations.js";

export class AutomationDraftBatchError extends Error {
  readonly path: string;
  readonly commandPath?: string;
  constructor(readonly code: string, path: string, commandPath?: string) {
    const boundedPath = path.length <= 240 ? path : `${path.slice(0, 240)}…`;
    super(`${code}:${boundedPath}`);
    this.path = boundedPath;
    if (commandPath !== undefined)
      this.commandPath = commandPath.length <= 240 ? commandPath : `${commandPath.slice(0, 240)}…`;
    this.name = "AutomationDraftBatchError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveIdentity(value: unknown, aliases: ReadonlyMap<string, string>, path: string): unknown {
  if (typeof value !== "string" || !value.startsWith("$")) return value;
  const resolved = aliases.get(value.slice(1));
  if (!resolved) throw new AutomationDraftBatchError("automation_batch_alias_unknown", path);
  return resolved;
}

function resolveBinding(value: unknown, aliases: ReadonlyMap<string, string>, path: string): unknown {
  if (!isRecord(value)) return value;
  if (value.kind === "node_result")
    return { ...value, nodeId: resolveIdentity(value.nodeId, aliases, `${path}.nodeId`) };
  if (value.kind === "branch_results")
    return { ...value, parallelNodeId: resolveIdentity(value.parallelNodeId, aliases, `${path}.parallelNodeId`) };
  return value;
}

function resolveNodeBindings(
  node: Record<string, unknown>, aliases: ReadonlyMap<string, string>, path: string,
): Record<string, unknown> {
  const resolved = { ...node };
  for (const key of ["controls", "inputs"]) {
    const bindings = node[key];
    if (!isRecord(bindings)) continue;
    resolved[key] = Object.fromEntries(Object.entries(bindings).map(([name, binding]) =>
      [name, resolveBinding(binding, aliases, `${path}.${key}.${name}`)]));
  }
  if (Object.hasOwn(node, "payload"))
    resolved.payload = resolveBinding(node.payload, aliases, `${path}.payload`);
  return resolved;
}

/** Only canonical identity slots participate; literal contents remain exact. */
export function resolveDraftBatchMutation(
  mutation: DraftMutation, aliases: ReadonlyMap<string, string>, path: string,
): DraftMutation {
  const id = (value: string, field: string) =>
    resolveIdentity(value, aliases, `${path}.${field}`) as string;
  switch (mutation.kind) {
    case "add_node":
      return { ...mutation, parentSequenceId: id(mutation.parentSequenceId, "parentSequenceId"),
        nodeWithoutId: resolveNodeBindings(mutation.nodeWithoutId, aliases, `${path}.nodeWithoutId`) };
    case "update_node":
      return { ...mutation, nodeId: id(mutation.nodeId, "nodeId"),
        patch: resolveNodeBindings(mutation.patch, aliases, `${path}.patch`) };
    case "remove_node":
      return { ...mutation, nodeId: id(mutation.nodeId, "nodeId") };
    case "move_node":
      return { ...mutation, nodeId: id(mutation.nodeId, "nodeId"),
        parentSequenceId: id(mutation.parentSequenceId, "parentSequenceId") };
    case "wrap_parallel":
      return { ...mutation, nodeIds: mutation.nodeIds.map((nodeId, index) => id(nodeId, `nodeIds.${index}`)) };
    case "update_definition":
      return mutation;
  }
}

function graphNodes(node: WorkflowNode): WorkflowNode[] {
  if (node.kind === "sequence") return [node, ...node.children.flatMap(graphNodes)];
  if (node.kind === "parallel") return [node, ...node.branches.flatMap(graphNodes)];
  return [node];
}

export function projectDraftBatchAliases(
  definition: AutomationRevision, aliases: ReadonlyMap<string, string>,
): Readonly<Record<string, string>> {
  const existingIds = new Set(graphNodes(definition.body).map(({ id }) => id));
  return Object.fromEntries([...aliases].filter(([, id]) => existingIds.has(id)));
}

export function registerDraftBatchAlias(
  alias: string, mutation: DraftMutation, before: AutomationRevision,
  after: AutomationRevision, aliases: Map<string, string>, path: string,
): void {
  const createsAliasTarget = mutation.kind === "add_node" || mutation.kind === "wrap_parallel";
  if (!createsAliasTarget)
    throw new AutomationDraftBatchError("automation_batch_alias_target_invalid", path);
  const previous = new Set(graphNodes(before.body).map(({ id }) => id));
  const added = graphNodes(after.body).filter(({ id }) => !previous.has(id));
  const targetKind = mutation.kind === "wrap_parallel" ? "parallel" : mutation.nodeWithoutId.kind;
  const target = added.find((node) => node.kind === targetKind);
  if (!target) throw new AutomationDraftBatchError("automation_batch_alias_target_missing", path);
  aliases.set(alias, target.id);
  if (target.kind !== "parallel") return;
  for (const [index, branch] of target.branches.entries())
    aliases.set(`${alias}.branch${index + 1}`, branch.id);
}
