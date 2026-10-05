import { Buffer } from "node:buffer";
import { AUTOMATION_DRAFT_BATCH_LIMITS, AutomationDraftBatchError, parseAutomationDraftBatch,
  type AutomationDraftBatch } from "../../automations/draft-batch.js";
import { AUTOMATION_GRAPH_LIMITS } from "../../automations/limits.js";

export const AUTOMATION_CREATION_RECIPE_LIMITS = Object.freeze({
  executableNodes: Math.min(AUTOMATION_GRAPH_LIMITS.executableNodes, AUTOMATION_DRAFT_BATCH_LIMITS.commands),
  compiledCommands: AUTOMATION_DRAFT_BATCH_LIMITS.commands,
});

type RecipeLeaf = Readonly<{ key: string; node: Record<string, unknown> }>;
type RecipeParallel = Readonly<{ key: string; branches: readonly (readonly RecipeStep[])[] }>;
type RecipeStep = RecipeLeaf | RecipeParallel;
type RecipeState = { keys: Set<string>; leaves: number };
type BatchCommand = AutomationDraftBatch["commands"][number];

/** Dispatch by an owned field, including malformed recipes that must be rejected by this compiler. */
export function hasAutomationCreationRecipe(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  const hasPlainRecordPrototype = prototype === Object.prototype || prototype === null;
  if (!hasPlainRecordPrototype) return false;
  return Object.hasOwn(value, "steps");
}

function requireRecipeRecord(value: unknown, path: string): Record<string, unknown> {
  const isRecord = value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isRecord) throw new AutomationDraftBatchError("automation_recipe_invalid", path);
  return value as Record<string, unknown>;
}

function requireRecipeFields(record: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown !== undefined)
    throw new AutomationDraftBatchError("automation_recipe_field_unknown", `${path}.${unknown}`);
}

function snapshotRecipe(value: unknown): Record<string, unknown> {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); }
  catch { throw new AutomationDraftBatchError("automation_recipe_invalid", "recipe"); }
  if (serialized === undefined) throw new AutomationDraftBatchError("automation_recipe_invalid", "recipe");
  if (Buffer.byteLength(serialized, "utf8") > AUTOMATION_DRAFT_BATCH_LIMITS.bytes)
    throw new AutomationDraftBatchError("automation_batch_too_large", "recipe");
  return requireRecipeRecord(JSON.parse(serialized), "recipe");
}

function requireRecipeKey(value: unknown, path: string, state: RecipeState): string {
  const hasAliasSyntax = typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,47}$/u.test(value);
  if (!hasAliasSyntax) throw new AutomationDraftBatchError("automation_batch_alias_invalid", path);
  if (value === "root") throw new AutomationDraftBatchError("automation_batch_alias_invalid", path);
  if (state.keys.has(value)) throw new AutomationDraftBatchError("automation_batch_alias_duplicate", path);
  state.keys.add(value);
  return value;
}

function leafWithDefaults(input: Record<string, unknown>, path: string): Record<string, unknown> {
  const { key: _key, ...node } = input;
  if (input.kind === "tool") return { onFailure: "stop", controls: {}, ...node };
  if (input.kind !== "agent") throw new AutomationDraftBatchError("automation_recipe_step_kind_invalid", `${path}.kind`);
  return { onFailure: "stop", agentMode: "fast", roleInstructions: "", inputs: {}, tools: [],
    result: { kind: "text" }, ...node };
}

function parseRecipeSequence(value: unknown, path: string, depth: number, state: RecipeState): readonly RecipeStep[] {
  if (depth > AUTOMATION_GRAPH_LIMITS.nestingDepth)
    throw new AutomationDraftBatchError("automation_graph_too_deep", path);
  if (!Array.isArray(value)) throw new AutomationDraftBatchError("automation_recipe_steps_invalid", path);
  if (value.length > AUTOMATION_CREATION_RECIPE_LIMITS.executableNodes)
    throw new AutomationDraftBatchError("automation_recipe_capacity_exceeded", path);
  return value.map((step, index) => parseRecipeStep(step, `${path}.${index}`, depth, state));
}

function parseRecipeStep(value: unknown, path: string, depth: number, state: RecipeState): RecipeStep {
  const input = requireRecipeRecord(value, path);
  const key = requireRecipeKey(input.key, `${path}.key`, state);
  if (input.kind !== "parallel") {
    state.leaves += 1;
    if (state.leaves > AUTOMATION_CREATION_RECIPE_LIMITS.executableNodes)
      throw new AutomationDraftBatchError("automation_recipe_capacity_exceeded", path);
    return { key, node: leafWithDefaults(input, path) };
  }
  requireRecipeFields(input, ["key", "kind", "branches"], path);
  if (!Array.isArray(input.branches))
    throw new AutomationDraftBatchError("automation_parallel_invalid", `${path}.branches`);
  const branchCountAllowed = input.branches.length >= 2 && input.branches.length <= AUTOMATION_GRAPH_LIMITS.branchesPerGroup;
  if (!branchCountAllowed) throw new AutomationDraftBatchError("automation_parallel_invalid", `${path}.branches`);
  const branches = input.branches.map((value, index) => {
    const branchPath = `${path}.branches.${index}`;
    const branch = parseRecipeSequence(value, branchPath, depth + 2, state);
    if (branch.length === 0) throw new AutomationDraftBatchError("automation_parallel_invalid", branchPath);
    return branch;
  });
  return { key, branches };
}

function isRecipeParallel(step: RecipeStep): step is RecipeParallel {
  return "branches" in step;
}

/** A real executable leaf seeds its branch; no placeholder node is ever generated. */
function firstRecipeLeaf(step: RecipeStep): RecipeLeaf {
  if (!isRecipeParallel(step)) return step;
  return firstRecipeLeaf(step.branches[0]![0]!);
}

function emitRecipeLeaf(leaf: RecipeLeaf, parent: string, index: number, commands: BatchCommand[]): void {
  commands.push({ as: leaf.key, mutation: {
    kind: "add_node", parentSequenceId: parent, index, nodeWithoutId: leaf.node,
  } });
}

function emitRecipeParallel(
  step: RecipeParallel, parent: string, index: number, seeded: boolean, commands: BatchCommand[],
): void {
  const heads = step.branches.map((branch) => firstRecipeLeaf(branch[0]!));
  for (const [branchIndex, head] of heads.entries()) {
    const headAlreadyPresent = seeded && branchIndex === 0;
    if (headAlreadyPresent) continue;
    emitRecipeLeaf(head, parent, index + branchIndex, commands);
  }
  commands.push({ as: step.key, mutation: { kind: "wrap_parallel", nodeIds: heads.map(({ key }) => `$${key}`) } });
  for (const [branchIndex, branch] of step.branches.entries())
    emitRecipeSequence(branch, `$${step.key}.branch${branchIndex + 1}`, commands, heads[branchIndex]!.key);
}

function emitRecipeSequence(
  steps: readonly RecipeStep[], parent: string, commands: BatchCommand[], seededHead?: string,
): void {
  for (const [index, step] of steps.entries()) {
    const headAlreadyPresent = index === 0 && seededHead !== undefined;
    if (isRecipeParallel(step)) {
      emitRecipeParallel(step, parent, index, headAlreadyPresent, commands);
      continue;
    }
    if (headAlreadyPresent) continue;
    emitRecipeLeaf(step, parent, index, commands);
  }
}

/** Compile explicit workflow structure into the existing atomic draft language. No persistence or semantic choices. */
export function compileAutomationCreationRecipe(value: unknown): AutomationDraftBatch {
  const input = snapshotRecipe(value);
  requireRecipeFields(input, ["version", "settings", "steps"], "recipe");
  if (input.version !== 1) throw new AutomationDraftBatchError("automation_batch_version_invalid", "recipe.version");
  const state: RecipeState = { keys: new Set(), leaves: 0 };
  const steps = parseRecipeSequence(input.steps, "recipe.steps", 0, state);
  const commands: BatchCommand[] = [];
  if (Object.hasOwn(input, "settings")) {
    const patch = requireRecipeRecord(input.settings, "recipe.settings");
    if (Object.keys(patch).length > 0) commands.push({ mutation: { kind: "update_definition", patch } });
  }
  // Every leaf and parallel group emits one command; nonempty settings emit one more.
  const compiledCommandCount = state.keys.size + commands.length;
  if (compiledCommandCount > AUTOMATION_CREATION_RECIPE_LIMITS.compiledCommands)
    throw new AutomationDraftBatchError("automation_recipe_capacity_exceeded", "recipe.steps");
  emitRecipeSequence(steps, "$root", commands);
  // Canonical limits also apply after defaults and structural commands expand the recipe.
  return parseAutomationDraftBatch({ version: 1, commands });
}
