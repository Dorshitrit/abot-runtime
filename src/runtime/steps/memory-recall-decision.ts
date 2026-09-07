import { ROLE_MEMORY_RECALL_QUERY_MAX_LENGTH } from "../orchestration/role-calls/memory-recall-contract.js";

export type MemoryRecallDecision = Readonly<{
  action: "recall_memory";
  query: string;
  acknowledgement?: string;
  title?: string;
}>;

type MemoryRecallPresentationContract = Readonly<{
  includeAcknowledgement?: boolean;
  includeTitle?: boolean;
  acknowledgementMaxLength: number;
  titleMaxLength: number;
}>;

type MemoryRecallValidationIssue = Readonly<{
  code: string;
  path: string;
  message: string;
}>;

export function createMemoryRecallDecisionSchema(
  presentation: MemoryRecallPresentationContract,
): Record<string, unknown> {
  const properties = {
    action: { type: "string", enum: ["recall_memory"] },
    query: {
      type: "string",
      minLength: 1,
      maxLength: ROLE_MEMORY_RECALL_QUERY_MAX_LENGTH,
    },
    ...(presentation.includeAcknowledgement
      ? {
          acknowledgement: presentationTextSchema(
            presentation.acknowledgementMaxLength,
          ),
        }
      : {}),
    ...(presentation.includeTitle
      ? { title: presentationTextSchema(presentation.titleMaxLength) }
      : {}),
  };
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

export function isMemoryRecallDecisionRecord(
  record: Readonly<Record<string, unknown>>,
): boolean {
  return record.action === "recall_memory";
}

export function parseMemoryRecallDecision(
  record: Readonly<Record<string, unknown>>,
  options: MemoryRecallPresentationContract &
    Readonly<{ allowMemoryRecall?: boolean }>,
):
  | Readonly<{ ok: true; decision: MemoryRecallDecision }>
  | Readonly<{
      ok: false;
      stage: "domain_parser";
      issues: readonly MemoryRecallValidationIssue[];
    }> {
  const issues: MemoryRecallValidationIssue[] = [];
  if (!options.allowMemoryRecall) {
    issues.push({
      code: "memory_recall_unavailable",
      path: "decision.action",
      message: "recall_memory is not available for this decision.",
    });
  }
  const expectedKeys = [
    "action",
    "query",
    ...(options.includeAcknowledgement ? ["acknowledgement"] : []),
    ...(options.includeTitle ? ["title"] : []),
  ];
  if (!hasExactRecallDecisionKeys(record, expectedKeys)) {
    issues.push({
      code: "memory_recall_shape_invalid",
      path: "decision",
      message:
        "Decision fields must exactly match the offered recall_memory action.",
    });
  }
  const query = readRecallText(
    record.query,
    "query",
    1,
    ROLE_MEMORY_RECALL_QUERY_MAX_LENGTH,
    issues,
  );
  const acknowledgement = options.includeAcknowledgement
    ? readRecallText(
        record.acknowledgement,
        "acknowledgement",
        2,
        options.acknowledgementMaxLength,
        issues,
      )
    : undefined;
  const title = options.includeTitle
    ? readRecallText(record.title, "title", 2, options.titleMaxLength, issues)
    : undefined;
  if (issues.length > 0 || query === undefined) {
    return Object.freeze({
      ok: false,
      stage: "domain_parser",
      issues: Object.freeze(issues),
    });
  }
  return Object.freeze({
    ok: true,
    decision: Object.freeze({
      action: "recall_memory",
      query,
      ...(acknowledgement !== undefined ? { acknowledgement } : {}),
      ...(title !== undefined ? { title } : {}),
    }),
  });
}

export { buildMemoryRecallDecisionInstructions } from "./memory-recall-prompt.js";

function presentationTextSchema(maxLength: number): Record<string, unknown> {
  return { type: "string", minLength: 2, maxLength };
}

function hasExactRecallDecisionKeys(
  record: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(record);
  if (actualKeys.length !== expectedKeys.length) return false;
  return actualKeys.every((key) => expectedKeys.includes(key));
}

function readRecallText(
  value: unknown,
  field: string,
  minimumLength: number,
  maximumLength: number,
  issues: MemoryRecallValidationIssue[],
): string | undefined {
  if (hasBoundedRecallText(value, minimumLength, maximumLength))
    return value.trim();
  issues.push({
    code: `memory_recall_${field}_invalid`,
    path: `decision.${field}`,
    message: `${field} must contain ${minimumLength}-${maximumLength} characters.`,
  });
  return undefined;
}

function hasBoundedRecallText(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
): value is string {
  if (typeof value !== "string") return false;
  if (value.length > maximumLength) return false;
  return value.trim().length >= minimumLength;
}
