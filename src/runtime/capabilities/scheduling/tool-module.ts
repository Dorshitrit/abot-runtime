import type {
  ToolExecutionContext,
  ToolModuleDeclaration,
} from "../../../capabilities/tool-types.js";
import type { RuntimeConfig } from "../../ports.js";
import type {
  SchedulerScheduleInput,
  SchedulerService,
  UpdateSchedulerJobInput,
} from "../../scheduler/contracts.js";
import { resolveModelSelection } from "../../model/model-selection.js";
import { requireCreateCalendarTimeZone } from "./create-time-zone.js";
import { requireAvailableScheduleModel } from "./model-validation.js";
import { schedulingToolContract } from "./tool-contract.js";
import { createSchedulerJobPage } from "./job-list-page.js";

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`schedule_${field}_required`);
  if (!value.trim()) throw new Error(`schedule_${field}_required`);
  return value.trim();
}

function scheduleInput(
  params: Record<string, unknown>,
): SchedulerScheduleInput {
  const kind = params.scheduleKind;
  if (kind === "timer") return { kind, delayMs: Number(params.delayMs) };
  if (kind === "once")
    return { kind, at: requireText(params.at, "exact_time") };
  if (kind === "interval")
    return {
      kind,
      everyMs: Number(params.everyMs),
      ...(params.anchorAt
        ? { anchorAt: requireText(params.anchorAt, "anchor_time") }
        : {}),
    };
  if (kind === "daily")
    return { kind, at: requireText(params.at, "exact_time") };
  if (kind === "weekly")
    return {
      kind,
      at: requireText(params.at, "exact_time"),
      weekdays: Array.isArray(params.weekdays)
        ? params.weekdays.map(Number)
        : [],
    };
  if (kind === "monthly")
    return {
      kind,
      at: requireText(params.at, "exact_time"),
      dayOfMonth: Number(params.dayOfMonth),
    };
  throw new Error("schedule_kind_required");
}

function updateInput(
  params: Record<string, unknown>,
  config: RuntimeConfig,
): UpdateSchedulerJobInput {
  if (params.modelProfileId !== undefined) {
    requireAvailableScheduleModel(config, params.modelProfileId);
  }
  return {
    ...(params.title !== undefined
      ? { title: requireText(params.title, "title") }
      : {}),
    ...(params.prompt !== undefined
      ? { prompt: requireText(params.prompt, "prompt") }
      : {}),
    ...(params.modelProfileId !== undefined
      ? { modelProfileId: requireText(params.modelProfileId, "model") }
      : {}),
    ...(params.agentMode !== undefined
      ? { agentMode: params.agentMode as "fast" | "reasoning" | "deep" }
      : {}),
    ...(params.timeZone !== undefined
      ? { timeZone: requireText(params.timeZone, "time_zone") }
      : {}),
    ...(params.scheduleKind !== undefined
      ? { schedule: scheduleInput(params) }
      : {}),
  };
}

export function createSchedulingToolModule(
  service: SchedulerService,
  config: RuntimeConfig,
  ready: () => Promise<void>,
): ToolModuleDeclaration {
  async function execute(
    params: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<unknown> {
    await ready();
    context?.abortSignal?.throwIfAborted();
    const sessionId = requireText(
      context?.sharedState?.currentSessionId,
      "session",
    );
    const action = requireText(params.action, "action");
    if (action === "list") {
      const jobs = await service.list({ sessionId });
      return createSchedulerJobPage(jobs, params);
    }
    if (action === "create") {
      requireCreateCalendarTimeZone(params);
      const request = context?.sharedState?.requestContext;
      const selection = resolveModelSelection({
        agentMode: request?.agentMode,
        modelPreference: request?.modelPreference,
        modelPolicy: config.models,
      });
      return service.create({
        sessionId,
        title: requireText(params.title, "title"),
        prompt: requireText(params.prompt, "prompt"),
        modelProfileId: requireText(
          selection.execution.primaryProfileId,
          "model",
        ),
        agentMode: selection.agentMode,
        timeZone: params.timeZone
          ? requireText(params.timeZone, "time_zone")
          : Intl.DateTimeFormat().resolvedOptions().timeZone,
        schedule: scheduleInput(params),
      });
    }
    const id = requireText(params.jobId, "job_id");
    const job = await service.get(id);
    if (!job) throw new Error("schedule_job_not_found");
    if (job.sessionId !== sessionId) throw new Error("schedule_job_not_found");
    if (action === "get")
      return {
        job,
        runs: [...(await service.listRuns(id, { limit: 20 }))].reverse(),
      };
    if (action === "update")
      return service.update(id, updateInput(params, config));
    if (action === "pause") return service.pause(id);
    if (action === "resume") return service.resume(id);
    if (action === "cancel") return service.cancel(id);
    if (action === "run_now") return service.runNow(id);
    throw new Error("schedule_action_unknown");
  }

  return {
    definition: {
      name: "schedules",
      description:
        "Core local schedules for the current conversation: create, inspect, edit, pause, resume, cancel and run now. Scheduled requests run with FULL permissions using their saved model.",
      routingCapability: "semantic_mutation",
      catalogGroups: ["scheduling"],
      developmentRoles: ["auxiliary"],
      controlsRefinement: "mechanical_when_complete",
    },
    normalInvocation: schedulingToolContract,
    async implementation(params, context) {
      try {
        const result = await execute(params, context);
        const isScheduleMutation =
          params.action !== "list" && params.action !== "get";
        return {
          ok: true,
          output: JSON.stringify(result),
          producedNewInformation: true,
          data: {
            mutationEvidence: isScheduleMutation,
            currentStateEvidence: true,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          output: message,
          error: message,
          producedNewInformation: false,
        };
      }
    },
  };
}
