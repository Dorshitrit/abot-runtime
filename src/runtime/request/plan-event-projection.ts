export type PlanItemStatus = "pending" | "in_progress" | "done" | "blocked";

type ProjectablePlan = Readonly<{
  definition: Readonly<{
    summary: string;
    items: readonly Readonly<{
      itemId: string;
      title: string;
    }>[];
  }>;
  itemStates: readonly Readonly<{
    itemId: string;
    status: PlanItemStatus;
  }>[];
}>;

export type RequestPlanProjectionState = Readonly<{
  plan?: ProjectablePlan;
}>;

export type RequestPlanEventPhase = "created" | "updated";

export type RequestPlanEventItem = Readonly<{
  id: string;
  title: string;
  status: PlanItemStatus;
  order: number;
  total: number;
}>;

export type RequestPlanEventSnapshot = Readonly<{
  summary: string;
  total: number;
  completed: number;
  blocked: number;
  pending: number;
  inProgress: number;
  items: readonly RequestPlanEventItem[];
}>;

export type RequestPlanItemChange = Readonly<{
  item: RequestPlanEventItem;
  previousStatus?: PlanItemStatus;
}>;

export type RequestPlanCommitProjection = Readonly<{
  phase: RequestPlanEventPhase;
  plan: RequestPlanEventSnapshot;
  previousPlan?: RequestPlanEventSnapshot;
  itemChanges: readonly RequestPlanItemChange[];
}>;

export type RequestPlanClientEvent = Readonly<{
  name: string;
  payload: Readonly<Record<string, unknown>>;
}>;

export type RequestPlanEventPresentation<
  TEvent extends RequestPlanClientEvent,
> = Readonly<{
  project(projection: RequestPlanCommitProjection): readonly TEvent[];
}>;

/**
 * Projects one already-committed request plan transition. The caller owns
 * presentation and emission; this function only detects canonical changes.
 */
export function projectRequestPlanCommit<
  TState extends RequestPlanProjectionState,
  TEvent extends RequestPlanClientEvent,
>(
  params: Readonly<{
    previousState: TState;
    state: TState;
    presentation: RequestPlanEventPresentation<TEvent>;
  }>,
): readonly TEvent[] {
  const currentPlan = params.state.plan;
  if (!currentPlan) return Object.freeze([]);

  const current = buildRequestPlanSnapshot(currentPlan);
  const previous = params.previousState.plan
    ? buildRequestPlanSnapshot(params.previousState.plan)
    : undefined;
  if (previous && sameSnapshot(previous, current)) {
    return Object.freeze([]);
  }

  const previousStatusById = new Map(
    previous?.items.map((item) => [item.id, item.status]),
  );
  const itemChanges = Object.freeze(
    current.items.flatMap((item) => {
      const previousStatus = previousStatusById.get(item.id);
      if (item.status === previousStatus) return [];
      return [
        Object.freeze({
          item,
          ...(previousStatus ? { previousStatus } : {}),
        }),
      ];
    }),
  );
  const projection: RequestPlanCommitProjection = Object.freeze({
    phase: previous ? "updated" : "created",
    plan: current,
    ...(previous ? { previousPlan: previous } : {}),
    itemChanges,
  });
  return Object.freeze([...params.presentation.project(projection)]);
}

function buildRequestPlanSnapshot(
  plan: ProjectablePlan,
): RequestPlanEventSnapshot {
  const statusById = new Map(
    plan.itemStates.map((item) => [item.itemId, item.status]),
  );
  const total = plan.definition.items.length;
  const items = plan.definition.items.map((definition, index) => {
    const status = statusById.get(definition.itemId);
    if (!status) {
      throw new TypeError(
        "Canonical plan projection requires one status for every item.",
      );
    }
    return Object.freeze({
      id: definition.itemId,
      title: definition.title,
      status,
      order: index + 1,
      total,
    });
  });
  return Object.freeze({
    summary: plan.definition.summary,
    total,
    completed: items.filter((item) => item.status === "done").length,
    blocked: items.filter((item) => item.status === "blocked").length,
    pending: items.filter((item) => item.status === "pending").length,
    inProgress: items.filter((item) => item.status === "in_progress").length,
    items: Object.freeze(items),
  });
}

function sameSnapshot(
  left: RequestPlanEventSnapshot,
  right: RequestPlanEventSnapshot,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
