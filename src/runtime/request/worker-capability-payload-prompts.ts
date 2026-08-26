import type { RawModelRepairHintInput } from "../model/invoke-raw-step.js";

export function buildWorkerCapabilityPayloadRepairHint(
  input: RawModelRepairHintInput,
): string {
  const issue = input.issues[0];
  return [
    "Your previous payload was rejected before it reached a tool, file mutation, or user response.",
    "Correct the same immutable payload assignment; do not change its capability, target, controls, or intent.",
    `Repair attempt: ${input.repairAttempt}.`,
    `Validation issue: ${issue?.message ?? "Return the complete required payload."} (${issue?.code ?? "payload_output_invalid"}).`,
    issue?.code === "payload_model_output_invalid"
      ? "Return exactly one valid JSON value matching the frozen response format and nothing else. Do not return an explanation or Markdown fences."
      : issue?.code === "payload_body_too_small"
        ? "Return only the complete non-empty payload required by the accepted assignment. Do not return an explanation or Markdown fences unless the payload itself requires them."
        : issue?.code === "payload_body_too_large"
          ? "Return only the complete payload required by the accepted assignment within its byte limit. Remove only unnecessary repetition or padding; do not return an explanation or Markdown fences unless the payload itself requires them."
          : "Return only the complete payload required by the accepted assignment. Be concise, do not repeat text or add padding, and do not return an explanation or Markdown fences unless the payload itself requires them.",
  ].join("\n");
}
