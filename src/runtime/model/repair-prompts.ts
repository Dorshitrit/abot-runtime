import type { ChatMessage } from "../../model-gateway/types.js";

type RepairIssue = Readonly<{
  code: string;
  path: string;
  message: string;
}>;

export const STRUCTURED_MODEL_MAX_REPAIR_ATTEMPTS = 2;

export function buildStructuredModelRepairHint(
  params: Readonly<{
    repairAttempt: number;
    stage: string;
    issues: readonly RepairIssue[];
    repeatedInvalidOutput: boolean;
  }>,
): string {
  const issueLines = params.issues.map(
    (issue, index) =>
      `${index + 1}. ${issue.path}: ${issue.message} (${issue.code})`,
  );
  return [
    "Your previous output was rejected before it caused any role, capability, tool, or ledger action.",
    "Correct the same decision for the same assignment now.",
    `Repair attempt: ${params.repairAttempt}.`,
    `Validation stage: ${params.stage}.`,
    ...(params.repeatedInvalidOutput
      ? [
          "Your last correction repeated the same invalid output. Change the listed fields before returning.",
        ]
      : []),
    "Return exactly one complete corrected JSON object matching the supplied schema and nothing else.",
    "Do not repeat the rejected output unchanged. Do not explain, apologize, invoke anything, or describe the correction.",
    "Correct every listed issue:",
    ...(issueLines.length > 0
      ? issueLines
      : ["1. Rebuild the complete decision from the supplied schema."]),
    "Follow the supplied schema for absent values: use null when the schema requires the property, and omit it only when omission is allowed.",
  ].join("\n");
}

/** Bind the latest validator guidance to a fresh attempt, keeping the original turns intact. */
export function buildModelRepairAttemptMessages(
  originalMessages: readonly ChatMessage[],
  repairHint: string,
): ChatMessage[] {
  const firstTurn = originalMessages.findIndex((message) => message.role !== "system");
  const endOfInstructions = firstTurn === -1 ? originalMessages.length : firstTurn;
  const messages = [...originalMessages];
  messages.splice(endOfInstructions, 0, Object.freeze({ role: "system", content: repairHint }));
  return messages;
}
