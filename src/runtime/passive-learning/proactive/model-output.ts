import { traceDebug } from "../../observability/debug-logger.js";
import { validateProactiveDecision, type ProactiveDecision, type ProactiveReviewInput } from "./contracts.js";

/** Explanation is optional model metadata, not evidence or permission to act. */
export function decodeProactiveModelDecision(text: string, input: ProactiveReviewInput): ProactiveDecision {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch {
    traceDebug("runtime.passive_learning", "proactive.output_rejected", {
      requestId: `proactive:${input.reviewId}`, reviewId: input.reviewId, modelProfileId: input.modelProfileId,
      outputCharacters: text.length, reason: "proactive_output_invalid_json",
    });
    throw new Error("proactive_output_invalid_json");
  }
  const object = proactiveOutputObject(value);
  const explanation = normalizeProactiveExplanation(object?.reason);
  const diagnostics = {
    requestId: `proactive:${input.reviewId}`, reviewId: input.reviewId, modelProfileId: input.modelProfileId,
    outputCharacters: text.length, reasonState: explanation.state,
    reasonCharacters: typeof object?.reason === "string" ? object.reason.length : null,
  };
  try {
    const decision = validateProactiveDecision(object ? { ...object, reason: explanation.text } : value,
      input.context.entries, Date.parse(input.context.referenceTime));
    traceDebug("runtime.passive_learning", "proactive.output_accepted", { ...diagnostics, kind: decision.kind });
    return decision;
  } catch (error) {
    const reason = error instanceof Error && /^proactive_[a-z_]+$/u.test(error.message)
      ? error.message : "proactive_decision_invalid";
    traceDebug("runtime.passive_learning", "proactive.output_rejected", { ...diagnostics, reason });
    throw error;
  }
}

function proactiveOutputObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function normalizeProactiveExplanation(value: unknown): { text: string; state: string } {
  const omitted = { text: "No explanation provided by the model.", state: "omitted" };
  if (value === null || value === undefined) return omitted;
  if (typeof value !== "string") return { ...omitted, state: "invalid_type" };
  const text = value.trim();
  if (!text) return { ...omitted, state: "empty" };
  if (text.length > 1000) return { text: text.slice(0, 1000), state: "truncated" };
  return { text, state: "provided" };
}
