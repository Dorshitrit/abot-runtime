type PlannerEventPayload = {
  plan?: unknown;
  item?: unknown;
  [key: string]: unknown;
};

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function getPlannerPlanDetails(payload: PlannerEventPayload): {
  summary: string;
  total: number;
  completed: number;
  items: Array<{ title: string; status: string }>;
} {
  const plan = getRecord(payload.plan);
  if (!plan) {
    return {
      summary: "",
      total: 0,
      completed: 0,
      items: [],
    };
  }

  const items = Array.isArray(plan.items)
    ? plan.items.flatMap((item) => {
        const record = getRecord(item);
        if (!record || typeof record.title !== "string") {
          return [];
        }
        return [
          {
            title: record.title,
            status:
              typeof record.status === "string" ? record.status : "pending",
          },
        ];
      })
    : [];
  const completed = getNumber(
    plan.completed,
    items.filter((item) => item.status === "done").length,
  );
  return {
    summary: typeof plan.summary === "string" ? plan.summary : "",
    total: getNumber(plan.total, items.length),
    completed,
    items,
  };
}

export function formatPlannerPlanTitle(payload: PlannerEventPayload): string {
  const plan = getPlannerPlanDetails(payload);
  return `Planner plan: ${plan.completed}/${plan.total} complete`;
}

export function formatDevelopmentProgressTitle(
  payload: PlannerEventPayload,
): string {
  const plan = getPlannerPlanDetails(payload);
  return `Development progress: ${plan.completed}/${plan.total} complete`;
}

function getPlannerPlanItemTitle(payload: PlannerEventPayload): string {
  const item = getRecord(payload.item);
  const title = typeof item?.title === "string" ? item.title.trim() : "";
  return title || "planned task";
}

export function formatPlannerPlanItemEventTitle(
  action: "planned" | "started" | "completed" | "blocked" | "reopened",
  payload: PlannerEventPayload,
): string {
  return `Planner ${action}: ${getPlannerPlanItemTitle(payload)}`;
}
