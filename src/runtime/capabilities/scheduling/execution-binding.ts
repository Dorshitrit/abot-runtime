import { createHash } from "node:crypto";
import type { ToolPermissionMode } from "../../../capabilities/tool-permission-mode.js";
import type { ToolCallAdapter, ToolExecutionContext } from "../../../capabilities/tool-types.js";
import type { SchedulerJob, SchedulerService } from "../../scheduler/contracts.js";
import type { SchedulerJobMutationGuard } from "../../scheduler/job-mutation-guard.js";

const TARGET_MUTATIONS = new Set(["update", "pause", "resume", "cancel", "run_now"]);
const UNTARGETED_ACTIONS = new Set(["list", "get", "create"]);

function requireScheduleBindingText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`schedule_${field}_required`);
  return value.trim();
}

function scheduleExecutionIdentity(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(["schedules", ...parts])).digest("hex");
}

function scheduleTargetIdentity(job: SchedulerJob, action: string, mode: ToolPermissionMode): string {
  return scheduleExecutionIdentity([job.sessionId, job.id, job.revision, action, job.toolPermissionMode, mode]);
}

export function isScheduleTargetMutation(action: string): boolean {
  return TARGET_MUTATIONS.has(action);
}

function requiresScheduleTargetApproval(mode: ToolPermissionMode, job: SchedulerJob): boolean {
  if (mode === "full_plus") return false;
  return job.toolPermissionMode === "full_plus";
}

export function createSchedulingExecutionAdapter(
  service: SchedulerService,
  ready: () => Promise<void>,
): ToolCallAdapter {
  return {
    async executionBinding(call, context) {
      context.abortSignal?.throwIfAborted();
      const sessionId = requireScheduleBindingText(context.sessionId, "session");
      const action = requireScheduleBindingText(call.params.action, "action");
      if (UNTARGETED_ACTIONS.has(action))
        return { identity: scheduleExecutionIdentity([sessionId, action]) };
      if (!isScheduleTargetMutation(action)) throw new Error("schedule_action_unknown");
      const jobId = requireScheduleBindingText(call.params.jobId, "job_id");
      await ready();
      context.abortSignal?.throwIfAborted();
      const job = await service.get(jobId);
      context.abortSignal?.throwIfAborted();
      if (!job || job.sessionId !== sessionId) throw new Error("schedule_job_not_found");
      return {
        identity: scheduleTargetIdentity(job, action, context.toolPermissionMode),
        requiresApproval: requiresScheduleTargetApproval(context.toolPermissionMode, job),
        metadata: {
          scheduleAction: action,
          scheduleJobId: job.id,
          scheduleTitle: job.title.slice(0, 200),
          ...(job.title.length > 200 ? { scheduleTitleTruncated: true } : {}),
          scheduleExpectedRevision: job.revision,
          scheduleToolPermissionMode: job.toolPermissionMode,
        },
      };
    },
  };
}

function hasScheduleExecutionAuthority(
  authority: ToolExecutionContext["executionAuthority"],
): authority is NonNullable<ToolExecutionContext["executionAuthority"]> {
  if (!authority?.executionIdentity) return false;
  return ["ask", "full_access", "full_plus"].includes(authority.toolPermissionMode);
}

/** Only trusted invocation context can bind a target mutation; model params are never authority. */
export function requireScheduleExecutionGuard(
  job: SchedulerJob,
  action: string,
  authority: ToolExecutionContext["executionAuthority"],
): SchedulerJobMutationGuard {
  if (!hasScheduleExecutionAuthority(authority))
    throw new Error("schedule_execution_authority_required");
  if (authority.executionIdentity !== scheduleTargetIdentity(job, action, authority.toolPermissionMode))
    throw new Error("schedule_execution_identity_mismatch");
  return { sessionId: job.sessionId, expectedRevision: job.revision };
}
