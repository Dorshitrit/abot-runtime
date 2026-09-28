type LearningOutputType = "missing" | "null" | "array" | "object" | "string" | "number" | "boolean";
type InvalidJsonShape = "empty" | "markdown_fence" | "object_delimited" | "object_missing_closer" | "array_delimited" | "array_missing_closer" | "other";
type LearningEnvelopeReason = "learning_output_invalid_json" | "learning_output_object_required" |
  "learning_output_decisions_missing" | "learning_output_decisions_not_array" | "learning_output_decision_limit";

/** Shape metadata only: no model text, property names or decision values. */
export class LearningDecisionEnvelopeError extends Error {
  constructor(reason: LearningEnvelopeReason, readonly shape: Readonly<{
    rootType?: LearningOutputType;
    decisionsType?: LearningOutputType;
    decisionCount?: number;
    invalidJsonShape?: InvalidJsonShape;
    decisionLimit: number;
  }>) {
    super(reason);
    this.name = "LearningDecisionEnvelopeError";
  }
}

export function readLearningDecisionEnvelope(text: string, decisionLimit: number): readonly unknown[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new LearningDecisionEnvelopeError("learning_output_invalid_json", {
      decisionLimit, invalidJsonShape: classifyInvalidJsonShape(text),
    });
  }
  const rootType = learningOutputType(decoded);
  if (!isLearningEnvelopeObject(decoded)) {
    throw new LearningDecisionEnvelopeError("learning_output_object_required", { rootType, decisionLimit });
  }
  if (!Object.hasOwn(decoded, "decisions")) {
    throw new LearningDecisionEnvelopeError("learning_output_decisions_missing", {
      rootType, decisionsType: "missing", decisionLimit,
    });
  }
  const decisions = decoded.decisions;
  const shape = { rootType, decisionsType: learningOutputType(decisions), decisionLimit };
  if (!Array.isArray(decisions)) {
    throw new LearningDecisionEnvelopeError("learning_output_decisions_not_array", shape);
  }
  if (decisions.length > decisionLimit) {
    throw new LearningDecisionEnvelopeError("learning_output_decision_limit", { ...shape, decisionCount: decisions.length });
  }
  return decisions;
}

function classifyInvalidJsonShape(text: string): InvalidJsonShape {
  const trimmed = text.trim();
  if (!trimmed) return "empty";
  if (trimmed.startsWith("```")) return "markdown_fence";
  if (trimmed.startsWith("{")) return trimmed.endsWith("}") ? "object_delimited" : "object_missing_closer";
  if (trimmed.startsWith("[")) return trimmed.endsWith("]") ? "array_delimited" : "array_missing_closer";
  return "other";
}

function isLearningEnvelopeObject(value: unknown): value is Record<string, unknown> {
  if (value === null) return false;
  if (Array.isArray(value)) return false;
  return typeof value === "object";
}

function learningOutputType(value: unknown): LearningOutputType {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value as Exclude<LearningOutputType, "missing" | "null" | "array">;
}
