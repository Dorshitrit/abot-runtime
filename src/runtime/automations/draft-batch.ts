import type { AutomationRevision } from "./definition-contracts.js";
import { parseAutomationDefinition } from "./definition-input.js";
import { applyDraftMutation, parseDraftMutation, type DraftMutation } from "./draft-mutations.js";
import { compileAutomationGraph, type AutomationGraphIssue } from "./graph-validation.js";
import { AutomationDraftBatchError, projectDraftBatchAliases, registerDraftBatchAlias, resolveDraftBatchMutation } from "./draft-batch-aliases.js";
export { AutomationDraftBatchError } from "./draft-batch-aliases.js";

export const AUTOMATION_DRAFT_BATCH_LIMITS = Object.freeze({ commands: 32, bytes: 32 * 1024 });
type DraftBatchCommand = Readonly<{ as?: string; mutation: DraftMutation }>;
export type AutomationDraftBatch = Readonly<{ version: 1; commands: readonly DraftBatchCommand[] }>;
export type AutomationDraftBatchResult = Readonly<{
  definition: AutomationRevision;
  aliases: Readonly<Record<string, string>>;
}>;

export class AutomationDraftBatchGraphError extends AutomationDraftBatchError {
  readonly issues: readonly AutomationGraphIssue[];
  readonly omittedIssueCount: number;
  constructor(issues: readonly AutomationGraphIssue[]) {
    super(issues[0]!.code, issues[0]!.path);
    this.issues = issues.slice(0, 8);
    this.omittedIssueCount = Math.max(0, issues.length - this.issues.length);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new AutomationDraftBatchError("automation_batch_invalid", path);
  return value;
}

function requireKnownFields(record: Record<string, unknown>, fields: readonly string[], path: string): void {
  const unknown = Object.keys(record).find((key) => !fields.includes(key));
  if (unknown !== undefined)
    throw new AutomationDraftBatchError("automation_batch_field_unknown", `${path}.${unknown}`);
}

const MUTATION_FIELDS: Readonly<Record<DraftMutation["kind"], readonly string[]>> = {
  add_node: ["kind", "parentSequenceId", "index", "nodeWithoutId"],
  update_node: ["kind", "nodeId", "patch"],
  remove_node: ["kind", "nodeId"],
  move_node: ["kind", "nodeId", "parentSequenceId", "index"],
  wrap_parallel: ["kind", "nodeIds"],
  update_definition: ["kind", "patch"],
};

function isKnownMutationKind(value: unknown): value is DraftMutation["kind"] {
  if (typeof value !== "string") return false;
  return Object.hasOwn(MUTATION_FIELDS, value);
}

function requireMutationFields(input: Record<string, unknown>, fields: readonly string[], path: string): void {
  const missing = fields.find((field) => !Object.hasOwn(input, field));
  if (missing !== undefined)
    throw new AutomationDraftBatchError("automation_batch_field_required", `${path}.${missing}`);
}

function parseBatchMutation(value: unknown, path: string): DraftMutation {
  const input = requireRecord(value, path);
  requireMutationFields(input, ["kind"], path);
  if (!isKnownMutationKind(input.kind))
    throw new AutomationDraftBatchError("automation_batch_mutation_kind_invalid", `${path}.kind`);
  const fields = MUTATION_FIELDS[input.kind];
  requireMutationFields(input, fields, path);
  requireKnownFields(input, fields, path);
  return withMutationPath(path, () => parseDraftMutation(input));
}

function snapshotBatchInput(value: unknown): unknown {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); }
  catch { throw new AutomationDraftBatchError("automation_batch_invalid", "plan"); }
  if (serialized === undefined) throw new AutomationDraftBatchError("automation_batch_invalid", "plan");
  if (Buffer.byteLength(serialized, "utf8") > AUTOMATION_DRAFT_BATCH_LIMITS.bytes)
    throw new AutomationDraftBatchError("automation_batch_too_large", "plan");
  return JSON.parse(serialized) as unknown;
}

function requireAlias(value: unknown, mutation: DraftMutation, path: string, seen: Set<string>): string {
  const isValidAlias = typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,47}$/u.test(value);
  if (!isValidAlias || value === "root")
    throw new AutomationDraftBatchError("automation_batch_alias_invalid", path);
  if (seen.has(value)) throw new AutomationDraftBatchError("automation_batch_alias_duplicate", path);
  const createsAliasTarget = mutation.kind === "add_node" || mutation.kind === "wrap_parallel";
  if (!createsAliasTarget) throw new AutomationDraftBatchError("automation_batch_alias_target_invalid", path);
  seen.add(value);
  return value;
}

function withMutationPath<T>(path: string, execute: () => T): T {
  try { return execute(); }
  catch (error) {
    if (error instanceof AutomationDraftBatchError) throw error;
    const definitionIssuePath = error instanceof Error
      ? /^automation_graph_invalid: (.+)$/u.exec(error.message)?.[1] : undefined;
    if (definitionIssuePath)
      throw new AutomationDraftBatchError("automation_graph_invalid", definitionIssuePath, path);
    const code = error instanceof Error && /^automation_[a-z_]+$/u.test(error.message)
      ? error.message : "automation_batch_invalid";
    throw new AutomationDraftBatchError(code, path);
  }
}

export function parseAutomationDraftBatch(value: unknown): AutomationDraftBatch {
  const input = requireRecord(snapshotBatchInput(value), "plan");
  requireKnownFields(input, ["version", "commands"], "plan");
  if (input.version !== 1) throw new AutomationDraftBatchError("automation_batch_version_invalid", "plan.version");
  const hasBoundedCommands = Array.isArray(input.commands) && input.commands.length >= 1 &&
    input.commands.length <= AUTOMATION_DRAFT_BATCH_LIMITS.commands;
  if (!hasBoundedCommands) throw new AutomationDraftBatchError("automation_batch_commands_invalid", "plan.commands");
  const aliases = new Set<string>();
  const commands = (input.commands as unknown[]).map((value, index) => {
    const path = `plan.commands.${index}`;
    const command = requireRecord(value, path);
    requireKnownFields(command, ["as", "mutation"], path);
    const mutation = parseBatchMutation(command.mutation, `${path}.mutation`);
    if (!Object.hasOwn(command, "as")) return { mutation };
    return { mutation, as: requireAlias(command.as, mutation, `${path}.as`, aliases) };
  });
  return { version: 1, commands };
}

function isPermittedEmptyDraft(definition: AutomationRevision, issues: readonly AutomationGraphIssue[]): boolean {
  if (definition.body.children.length !== 0) return false;
  if (issues.length !== 1) return false;
  return issues[0]!.code === "automation_graph_empty";
}

/** No journal writes occur here; empty roots remain editable drafts, never executable graphs. */
export function applyAutomationDraftBatch(
  current: AutomationRevision, plan: AutomationDraftBatch, revision: number,
): AutomationDraftBatchResult {
  const aliases = new Map([["root", current.body.id]]);
  let definition = current;
  for (const [index, command] of plan.commands.entries()) {
    const path = `plan.commands.${index}`;
    const mutation = resolveDraftBatchMutation(command.mutation, aliases, `${path}.mutation`);
    const previous = definition;
    definition = withMutationPath(`${path}.mutation`, () =>
      applyDraftMutation({ ...definition, revision: current.revision }, mutation));
    if (command.as)
      registerDraftBatchAlias(command.as, mutation, previous, definition, aliases, `${path}.as`);
  }
  definition = withMutationPath("plan", () => parseAutomationDefinition({ ...definition, revision }));
  const compiled = compileAutomationGraph(definition);
  const result = { definition, aliases: projectDraftBatchAliases(definition, aliases) };
  if (compiled.ok) return result;
  if (isPermittedEmptyDraft(definition, compiled.issues)) return result;
  throw new AutomationDraftBatchGraphError(compiled.issues);
}
