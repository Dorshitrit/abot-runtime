import type { ChatMessage } from "../../model-gateway/types.js";
import type { RequestMessagesBudgetAssessment } from "../context/request-context-budget.js";
import { traceDebug } from "../observability/debug-logger.js";
import { requiresContextCompaction } from "./context-compaction-admission.js";
import type { ModelStepOptionalContextProjection } from "./model-step-port.js";

type OptionalContextEnvelope = Readonly<{
  messages: readonly ChatMessage[];
  assessment: RequestMessagesBudgetAssessment;
}>;

/** Optional references yield at the existing pressure threshold, even for exact input. */
export async function admitOptionalModelContext(params: OptionalContextEnvelope & Readonly<{
  project?: ModelStepOptionalContextProjection;
  assess(messages: readonly ChatMessage[]): Promise<RequestMessagesBudgetAssessment>;
  assertCurrent(): void;
  diagnostic: Readonly<{ requestId: string; modelStep: string }>;
}>): Promise<OptionalContextEnvelope> {
  if (!params.project) return params;
  if (!requiresContextCompaction(true, params.assessment)) return params;
  params.assertCurrent();
  const messages = params.project(params.messages);
  if (messages === params.messages) return params;
  params.assertCurrent();
  const assessment = await params.assess(messages);
  params.assertCurrent();
  traceDebug("runtime.context", "optional_context.projected", {
    ...params.diagnostic,
    beforeMessageCount: params.messages.length,
    afterMessageCount: messages.length,
    fits: assessment.fits,
  });
  return { messages, assessment };
}
