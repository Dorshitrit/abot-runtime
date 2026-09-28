import { RequestModelStepInvoker } from "../model/invoke-step.js";
import type { ModelStepInvocationInput, ModelStepOutputDiagnostics } from "../model/model-step-port.js";
import { resolveOutputIncompleteError } from "../model/provider-completion.js";
import { traceDebug } from "../observability/debug-logger.js";
import type { RequestModelInvocationView } from "../request/contracts.js";
import { LearningDecisionEnvelopeError } from "../long-term-memory/maturation/decision-envelope.js";
import { LearningReviewOutputError } from "./review-decision-adapter.js";
import { fingerprintReviewProgress, isReviewStageKey, MAX_CO_WORKER_REVIEW_STAGES,
  MAX_CO_WORKER_REVIEW_PROGRESS_AGE_MS, readCoWorkerReviewProgress,
  type CoWorkerReviewProgress, type ReviewProgressPort } from "./review-progress.js";

type StageInvocation<T> = Omit<ModelStepInvocationInput<T>, "accept"> & Readonly<{
  accept(text: string, diagnostics: ModelStepOutputDiagnostics & { acceptedAt: string }): T;
}>;
export type StagedReviewCall = <T>(
  stage: string, params: StageInvocation<T>, reuse?: (result: T) => boolean,
) => Promise<T>;

/** A finite caller-owned sequence; accepted stages are durable before another paid call. */
export async function runStagedCoWorkerReview<T>(options: Readonly<{
  request: RequestModelInvocationView;
  activity: "learning" | "proactive";
  reviewId: string;
  binding: unknown;
  referenceTime: string;
  expiresAt: string;
  maxCalls: number;
  progress?: ReviewProgressPort;
  now?: () => number;
  run(call: StagedReviewCall, referenceTime: string): Promise<T>;
}>): Promise<T> {
  const { request } = options;
  const now = options.now ?? Date.now;
  request.abortSignal.throwIfAborted();
  if (!hasValidReviewStageLimit(options.maxCalls))
    throw new Error("co_worker_review_stage_limit_invalid");
  const binding = fingerprintReviewProgress({ method: "super-v2", activity: options.activity,
    reviewId: options.reviewId, input: options.binding,
    preference: request.modelPreference, models: request.modelPolicy, runner: request.runnerConfig });
  const previous = readCoWorkerReviewProgress(options.progress?.read());
  const canResume = canResumeReview(previous, binding, now(), options.expiresAt);
  let progress: CoWorkerReviewProgress = canResume ? previous! : createProgress(options, binding);
  const correlation = { requestId: request.requestId, reviewId: options.reviewId,
    activity: options.activity, method: "staged", modelProfileId: request.modelPreference?.profileId };
  if (previous && !canResume) {
    await options.progress?.save(progress);
    traceDebug("runtime.passive_learning", "review.progress_discarded", { ...correlation, reason: "binding_or_retention_changed" });
  }
  const invoker = new RequestModelStepInvoker(request);
  const visited = new Set<string>();
  const call: StagedReviewCall = async (stage, params, reuse) => {
    assertReviewStageAdmission(stage, visited, options.maxCalls);
    request.abortSignal.throwIfAborted();
    assertReviewProgressUnexpired(progress, now());
    visited.add(stage);
    const fingerprint = fingerprintReviewProgress({ messages: params.messages, format: params.format,
      modelStep: params.modelStep, binding });
    const saved = progress.stages.find(item => item.key === stage && item.fingerprint === fingerprint);
    if (saved) {
      let result;
      try { result = params.accept(saved.response, { outputLength: saved.response.length, acceptedAt: saved.acceptedAt }); }
      catch (error) {
        traceDebug("runtime.passive_learning", "review.stage_failed", { ...correlation, stage,
          reason: safeStagedReviewFailure(error), ...reviewValidationDetails(error) });
        throw error;
      }
      request.abortSignal.throwIfAborted();
      assertReviewProgressUnexpired(progress, now());
      if (!reuse || reuse(result)) {
        traceDebug("runtime.passive_learning", "review.stage_resumed", { ...correlation, stage });
        return result;
      }
      traceDebug("runtime.passive_learning", "review.stage_invalidated", { ...correlation, stage, reason: "result_expired" });
    }
    traceDebug("runtime.passive_learning", "review.stage_started", { ...correlation, stage,
      inputCharacters: params.messages.reduce((sum, message) => sum + (message.content?.length ?? 0), 0),
      schemaCharacters: JSON.stringify(params.format ?? {}).length });
    try {
      let response = "";
      let acceptedAt = "";
      const result = await invoker.invoke({ ...params, accept(text, diagnostics) {
        const incomplete = resolveOutputIncompleteError(diagnostics, "learning.batch");
        if (incomplete) throw incomplete;
        acceptedAt = new Date(now()).toISOString();
        const accepted = params.accept(text, { ...diagnostics, acceptedAt });
        response = text;
        return accepted;
      } });
      request.abortSignal.throwIfAborted();
      assertReviewProgressUnexpired(progress, now());
      // Keep only the executed prefix when a stage's inputs change.
      const stages = progress.stages.filter(item => visited.has(item.key) && item.key !== stage);
      const next = readCoWorkerReviewProgress({ ...progress, stages: [...stages, { key: stage, fingerprint, response, acceptedAt }] })!;
      await options.progress?.save(next);
      progress = next;
      request.abortSignal.throwIfAborted();
      traceDebug("runtime.passive_learning", "review.stage_completed", { ...correlation, stage, savedStages: progress.stages.length });
      return result;
    } catch (error) {
      traceDebug("runtime.passive_learning", "review.stage_failed", { ...correlation, stage,
        reason: safeStagedReviewFailure(error), ...reviewValidationDetails(error) });
      throw error;
    }
  };
  const result = await options.run(call, progress.referenceTime);
  request.abortSignal.throwIfAborted();
  assertReviewProgressUnexpired(progress, now());
  return result;
}

function canResumeReview(progress: CoWorkerReviewProgress | undefined, binding: string, now: number, expiresAt: string): boolean {
  if (!progress || progress.binding !== binding) return false;
  if (Date.parse(progress.expiresAt) <= now) return false;
  return Date.parse(progress.expiresAt) <= Date.parse(expiresAt);
}
function createProgress(options: { referenceTime: string; expiresAt: string }, binding: string): CoWorkerReviewProgress {
  const expiresAt = new Date(Math.min(Date.parse(options.expiresAt),
    Date.parse(options.referenceTime) + MAX_CO_WORKER_REVIEW_PROGRESS_AGE_MS)).toISOString();
  return readCoWorkerReviewProgress({ schemaVersion: 1, method: "super-v2", binding,
    referenceTime: options.referenceTime, expiresAt, stages: [] })!;
}
function assertReviewStageAdmission(stage: string, visited: ReadonlySet<string>, maximum: number): void {
  if (!isReviewStageKey(stage)) throw new Error("co_worker_review_stage_order_invalid");
  if (visited.has(stage) || visited.size >= maximum) throw new Error("co_worker_review_stage_order_invalid");
}
function hasValidReviewStageLimit(value: number): boolean {
  if (!Number.isSafeInteger(value)) return false;
  if (value < 1) return false;
  return value <= MAX_CO_WORKER_REVIEW_STAGES;
}
function assertReviewProgressUnexpired(progress: CoWorkerReviewProgress, now: number): void {
  if (Date.parse(progress.expiresAt) <= now) throw new Error("learning_review_progress_expired");
}
function reviewValidationDetails(error: unknown): Record<string, unknown> {
  if (error instanceof LearningDecisionEnvelopeError) return { validation: { stage: "envelope", ...error.shape } };
  if (error instanceof LearningReviewOutputError) return { validation: error.diagnostics };
  return {};
}
function safeStagedReviewFailure(error: unknown): string {
  if (!(error instanceof Error)) return "learning_failed";
  if (/^(?:learning|proactive|co_worker)_[a-z_]{1,90}$/u.test(error.message)) return error.message;
  if (error.message === "output_incomplete") return error.message;
  return "learning_failed";
}
