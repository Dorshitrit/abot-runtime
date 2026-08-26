type PlanObjectiveItem = Readonly<{
  title: string;
  objective: string;
}>;

export function composeRoleCallPlanChildObjective(
  items: readonly PlanObjectiveItem[],
  maximumLength: number,
): string | undefined {
  if (
    items.length === 0 ||
    !Number.isSafeInteger(maximumLength) ||
    maximumLength < 1
  ) {
    return undefined;
  }
  const normalized = items.map((item) => ({
    title: item.title.trim(),
    objective: item.objective.trim(),
  }));
  if (
    normalized.some(
      (item) => item.title.length === 0 || item.objective.length === 0,
    )
  ) {
    return undefined;
  }
  const objective =
    normalized.length === 1
      ? normalized[0]!.objective
      : [
          "Complete these bound plan outcomes as one atomic delegated outcome:",
          ...normalized.map(
            (item, index) => `${index + 1}. ${item.title}\n${item.objective}`,
          ),
        ].join("\n\n");
  return objective.length <= maximumLength ? objective : undefined;
}

export function selectProposedPlanItems<TItem extends PlanObjectiveItem>(
  items: readonly TItem[],
  selectedItemIndexes: readonly number[],
): readonly TItem[] | undefined {
  if (
    selectedItemIndexes.length === 0 ||
    new Set(selectedItemIndexes).size !== selectedItemIndexes.length ||
    selectedItemIndexes.some(
      (index) =>
        !Number.isSafeInteger(index) || index < 0 || index >= items.length,
    )
  ) {
    return undefined;
  }
  const selected = new Set(selectedItemIndexes);
  return Object.freeze(items.filter((_item, index) => selected.has(index)));
}

export function selectDefinedPlanItems<
  TItem extends PlanObjectiveItem & Readonly<{ itemId: string }>,
>(
  definition: Readonly<{ items: readonly TItem[] }>,
  itemIds: readonly string[],
): readonly TItem[] | undefined {
  if (itemIds.length === 0 || new Set(itemIds).size !== itemIds.length) {
    return undefined;
  }
  const selected = new Set(itemIds);
  const items = definition.items.filter((item) => selected.has(item.itemId));
  return items.length === selected.size ? Object.freeze(items) : undefined;
}
