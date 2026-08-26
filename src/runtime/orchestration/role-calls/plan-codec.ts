import type { RoleCallPlanBinding } from "./contracts.js";

export function parseRoleCallPlanBinding(
  input: unknown,
): RoleCallPlanBinding | undefined {
  const binding = asRecord(input);
  if (!binding || typeof binding.mode !== "string") return undefined;
  if (binding.mode === "select") {
    const itemIds = parseUniqueStrings(binding.itemIds);
    return exactKeys(binding, ["mode", "itemIds"]) && itemIds
      ? Object.freeze({ mode: "select", itemIds })
      : undefined;
  }
  if (
    binding.mode === "extend" &&
    exactKeys(binding, ["mode", "extension", "selectedItemIndexes"])
  ) {
    const extension = asRecord(binding.extension);
    const items =
      extension && exactKeys(extension, ["items"])
        ? parseProposedItems(extension.items)
        : undefined;
    const selectedItemIndexes = parseUniqueIndexes(binding.selectedItemIndexes);
    return items && selectedItemIndexes
      ? Object.freeze({
          mode: "extend",
          extension: Object.freeze({ items }),
          selectedItemIndexes,
        })
      : undefined;
  }
  if (
    binding.mode !== "declare" ||
    !exactKeys(binding, ["mode", "plan", "selectedItemIndexes"])
  ) {
    return undefined;
  }
  const plan = asRecord(binding.plan);
  if (
    !plan ||
    !exactKeys(plan, ["summary", "items"]) ||
    typeof plan.summary !== "string" ||
    !Array.isArray(plan.items)
  ) {
    return undefined;
  }
  const items = parseProposedItems(plan.items);
  const selectedItemIndexes = parseUniqueIndexes(binding.selectedItemIndexes);
  if (!items || !selectedItemIndexes) return undefined;
  return Object.freeze({
    mode: "declare",
    plan: Object.freeze({
      summary: plan.summary,
      items,
    }),
    selectedItemIndexes,
  });
}

function parseUniqueStrings(input: unknown): readonly string[] | undefined {
  return Array.isArray(input) &&
    input.length > 0 &&
    input.every((value) => typeof value === "string") &&
    new Set(input).size === input.length
    ? Object.freeze([...input])
    : undefined;
}

function parseUniqueIndexes(input: unknown): readonly number[] | undefined {
  return Array.isArray(input) &&
    input.length > 0 &&
    input.every((value) => Number.isSafeInteger(value) && value >= 0) &&
    new Set(input).size === input.length
    ? Object.freeze([...(input as number[])])
    : undefined;
}

function parseProposedItems(
  input: unknown,
): readonly Readonly<{ title: string; objective: string }>[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const items: Array<{ title: string; objective: string }> = [];
  for (const inputItem of input) {
    const item = asRecord(inputItem);
    if (
      !item ||
      !exactKeys(item, ["title", "objective"]) ||
      typeof item.title !== "string" ||
      typeof item.objective !== "string"
    ) {
      return undefined;
    }
    items.push({ title: item.title, objective: item.objective });
  }
  return Object.freeze(items.map((item) => Object.freeze(item)));
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  return (
    actual.length === expected.size && actual.every((key) => expected.has(key))
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
