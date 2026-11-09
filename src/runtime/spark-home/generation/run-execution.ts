import { homeGenerationFailure, type SparkHomeEvidence, type SparkHomeGenerationDependencies,
  type SparkHomeRunContext, type SparkHomeRunPhase } from "./contracts.js";
import type { SparkHomeReadTools } from "./read-tools.js";
import { hasRequiredSparkHomeDashboardWidgets } from "../widgets/publication.js";

/** A closed finite sequence. No next-action loop or shared request orchestration. */
export async function executeSparkHomeRun(context: SparkHomeRunContext, tools: SparkHomeReadTools,
  dependencies: Pick<SparkHomeGenerationDependencies, "settings" | "screen">,
  phase: (phase: SparkHomeRunPhase) => Promise<void>): Promise<number> {
  const requirements = { instructions: context.settings.personalInstructions,
    ...(context.instruction ? { instruction: context.instruction } : {}) };
  const planning = { ...requirements, reference: context.sources.planning };
  context.signal.throwIfAborted();
  const plan = await context.model.plan({ ...planning, ...tools.planning() });
  const evidence: SparkHomeEvidence[] = [];
  await phase("collect");
  for (const read of plan.reads) evidence.push(await tools.read(read, context.sources));
  context.signal.throwIfAborted();
  await phase("followup");
  const followup = await context.model.followup({ ...planning, ...tools.planning(), direction: plan.direction, evidence });
  await phase("collect");
  for (const read of followup.reads) evidence.push(await tools.read(read, context.sources));
  context.signal.throwIfAborted();
  await phase("compose");
  const html = await context.model.html({ ...requirements, direction: followup.direction,
    reference: context.sources.authoring, evidence });
  context.signal.throwIfAborted();
  if (!hasRequiredSparkHomeDashboardWidgets(html)) return homeGenerationFailure("spark_home_dashboard_widgets_required");
  await phase("publish");
  return dependencies.settings.withCalibrationReady(async current => {
    if (current.revision !== context.settings.revision) return homeGenerationFailure("spark_home_settings_stale");
    if (current.modelProfileId !== context.settings.modelProfileId) return homeGenerationFailure("spark_home_model_changed");
    context.signal.throwIfAborted();
    const saved = await dependencies.screen.update({ expectedRevision: context.screenRevision, html }, { abortSignal: context.signal });
    return saved.revision;
  });
}
