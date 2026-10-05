import { randomUUID } from "node:crypto";
import type { AutomationRevision, SequenceNode } from "./definition-contracts.js";
import { parseAutomationDefinition } from "./definition-input.js";
import { DEFAULT_AUTOMATION_LIMITS } from "./limits.js";

export type DraftMutation =
  | Readonly<{ kind: "add_node"; parentSequenceId: string; index: number; nodeWithoutId: Record<string, unknown> }>
  | Readonly<{ kind: "update_node"; nodeId: string; patch: Record<string, unknown> }>
  | Readonly<{ kind: "remove_node"; nodeId: string }>
  | Readonly<{ kind: "move_node"; nodeId: string; parentSequenceId: string; index: number }>
  | Readonly<{ kind: "wrap_parallel"; nodeIds: readonly string[] }>
  | Readonly<{ kind: "update_definition"; patch: Record<string, unknown> }>;

const DEFINITION_EDITABLE = new Set([
  "title", "objective", "workingDirectory", "trigger", "source", "inputs", "limits",
]);
const NODE_EDITABLE = new Set([
  "title", "onFailure", "operation", "controls", "payload", "modelProfileId",
  "agentMode", "roleInstructions", "prompt", "inputs", "tools", "result",
  "acceptance", "savedAgentOrigin",
]);

function error(code: string): never {
  throw new Error(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, code: string): Record<string, unknown> {
  if (!isRecord(value)) error(code);
  return value;
}

function requireIndex(index: unknown, length: number): number {
  if (!Number.isSafeInteger(index) || Number(index) < 0 || Number(index) > length)
    error("automation_graph_invalid");
  return Number(index);
}

function requireMutationId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128)
    error("automation_graph_invalid");
  return value;
}

export function parseDraftMutation(value: unknown): DraftMutation {
  const input = requireRecord(value, "automation_graph_invalid");
  switch (input.kind) {
    case "add_node":
      return {
        kind: "add_node",
        parentSequenceId: requireMutationId(input.parentSequenceId),
        index: Number(input.index),
        nodeWithoutId: requireRecord(input.nodeWithoutId, "automation_graph_invalid"),
      };
    case "update_node":
      return {
        kind: "update_node",
        nodeId: requireMutationId(input.nodeId),
        patch: requireRecord(input.patch, "automation_graph_invalid"),
      };
    case "remove_node":
      return { kind: "remove_node", nodeId: requireMutationId(input.nodeId) };
    case "move_node":
      return {
        kind: "move_node",
        nodeId: requireMutationId(input.nodeId),
        parentSequenceId: requireMutationId(input.parentSequenceId),
        index: Number(input.index),
      };
    case "wrap_parallel":
      if (!Array.isArray(input.nodeIds) || !input.nodeIds.every((id) => typeof id === "string"))
        error("automation_graph_invalid");
      return { kind: "wrap_parallel", nodeIds: input.nodeIds };
    case "update_definition":
      return { kind: "update_definition", patch: requireRecord(input.patch, "automation_graph_invalid") };
    default:
      error("automation_graph_invalid");
  }
}

function createNodeId(): string {
  return `n_${randomUUID().replaceAll("-", "")}`;
}

type MutableNode = Record<string, unknown> & { kind: string; id: string };
type MutableSequence = MutableNode & { kind: "sequence"; children: MutableNode[] };

function descendantsOf(node: MutableNode): MutableNode[] {
  if (node.kind === "sequence") return (node as MutableSequence).children;
  if (node.kind === "parallel") return node.branches as MutableSequence[];
  return [];
}

function findSequence(node: MutableNode, id: string): MutableSequence | undefined {
  if (node.kind === "sequence" && node.id === id) return node as MutableSequence;
  for (const child of descendantsOf(node)) {
    const found = findSequence(child, id);
    if (found) return found;
  }
  return undefined;
}

function findNodeAndParent(
  node: MutableNode,
  id: string,
): { node: MutableNode; parent: MutableSequence; index: number } | undefined {
  if (node.kind === "sequence") {
    const sequence = node as MutableSequence;
    const index = sequence.children.findIndex((child) => child.id === id);
    if (index >= 0) return { node: sequence.children[index]!, parent: sequence, index };
  }
  for (const child of descendantsOf(node)) {
    const found = findNodeAndParent(child, id);
    if (found) return found;
  }
  return undefined;
}

function containsNode(node: MutableNode, id: string): boolean {
  if (node.id === id) return true;
  return descendantsOf(node).some((child) => containsNode(child, id));
}

function mutateNode(root: MutableNode, mutation: DraftMutation): void {
  switch (mutation.kind) {
    case "add_node": {
      const parent = findSequence(root, mutation.parentSequenceId);
      if (!parent) error("automation_dependency_missing");
      const supplied = requireRecord(mutation.nodeWithoutId, "automation_graph_invalid");
      if ("id" in supplied || !["agent", "tool"].includes(String(supplied.kind)))
        error("automation_graph_invalid");
      const node = { ...supplied, id: createNodeId() } as MutableNode;
      parent.children.splice(requireIndex(mutation.index, parent.children.length), 0, node);
      return;
    }
    case "update_node": {
      const found = findNodeAndParent(root, mutation.nodeId);
      if (!found) error("automation_dependency_missing");
      const patch = requireRecord(mutation.patch, "automation_graph_invalid");
      if (Object.keys(patch).some((key) => !NODE_EDITABLE.has(key))) error("automation_graph_invalid");
      const normalized = { ...patch };
      if (normalized.payload === null) {
        if (found.node.kind !== "tool") error("automation_graph_invalid");
        delete found.node.payload;
        delete normalized.payload;
      }
      Object.assign(found.node, normalized);
      return;
    }
    case "remove_node": {
      const found = findNodeAndParent(root, mutation.nodeId);
      if (!found) error("automation_dependency_missing");
      found.parent.children.splice(found.index, 1);
      return;
    }
    case "move_node": {
      const found = findNodeAndParent(root, mutation.nodeId);
      const parent = findSequence(root, mutation.parentSequenceId);
      if (!found || !parent) error("automation_dependency_missing");
      if (containsNode(found.node, parent.id)) error("automation_graph_invalid");
      const sameParent = found.parent === parent;
      const targetIndex = requireIndex(mutation.index, parent.children.length);
      found.parent.children.splice(found.index, 1);
      parent.children.splice(sameParent && targetIndex > found.index ? targetIndex - 1 : targetIndex, 0, found.node);
      return;
    }
    case "wrap_parallel": {
      const ids = mutation.nodeIds;
      if (!Array.isArray(ids) || ids.length < 2 || ids.length > 8 || new Set(ids).size !== ids.length)
        error("automation_graph_invalid");
      const found = ids.map((id) => findNodeAndParent(root, id));
      if (found.some((item) => !item)) error("automation_dependency_missing");
      const siblings = found as { node: MutableNode; parent: MutableSequence; index: number }[];
      const parent = siblings[0]!.parent;
      if (siblings.some((item) => item.parent !== parent || !["agent", "tool"].includes(item.node.kind)))
        error("automation_graph_invalid");
      const indices = siblings.map((item) => item.index).sort((left, right) => left - right);
      if (indices.some((value, index) => value !== indices[0]! + index)) error("automation_graph_invalid");
      const selected = parent.children.splice(indices[0]!, ids.length);
      const branches = selected.map((child) => ({ kind: "sequence", id: createNodeId(), children: [child] }));
      parent.children.splice(indices[0]!, 0, { kind: "parallel", id: createNodeId(), branches });
      return;
    }
    case "update_definition":
      return;
  }
}

/** A single structural mutation path for manual edits and model-authored edits. */
export function applyDraftMutation(
  current: AutomationRevision,
  mutation: DraftMutation,
): AutomationRevision {
  const changed = structuredClone(current) as unknown as Record<string, unknown>;
  if (mutation.kind === "update_definition") {
    const patch = requireRecord(mutation.patch, "automation_graph_invalid");
    if (Object.keys(patch).some((key) => !DEFINITION_EDITABLE.has(key))) error("automation_graph_invalid");
    const normalized = { ...patch };
    if (normalized.source === null) {
      delete changed.source;
      delete normalized.source;
    } else if (isRecord(normalized.source) && normalized.source.sourceId === "") {
      normalized.source = { ...normalized.source, sourceId: createNodeId() };
    }
    if (normalized.workingDirectory === null) {
      delete changed.workingDirectory;
      delete normalized.workingDirectory;
    }
    Object.assign(changed, normalized);
  } else {
    mutateNode(changed.body as MutableNode, mutation);
  }
  changed.revision = current.revision + 1;
  return parseAutomationDefinition(changed);
}

export function createEmptyAutomationDefinition(automationId: string, title: string): AutomationRevision {
  return {
    schemaVersion: 1,
    automationId,
    revision: 1,
    title,
    objective: "",
    trigger: { kind: "manual" },
    inputs: {},
    body: { kind: "sequence", id: createNodeId(), children: [] } satisfies SequenceNode,
    limits: { ...DEFAULT_AUTOMATION_LIMITS },
  };
}
