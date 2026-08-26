import type {
  DegradedFinalizationInput,
  DegradedFinalizationPhrasing,
} from "./contract.js";

export function renderDegradedFinalization(params: {
  input: DegradedFinalizationInput;
  phrasing: DegradedFinalizationPhrasing;
}): string {
  return [
    params.phrasing.failureNotice,
    renderCanonicalProgress(params.input),
    params.phrasing.nextStep,
  ]
    .filter((block) => block.length > 0)
    .join("\n\n");
}

function renderCanonicalProgress(input: DegradedFinalizationInput): string {
  if (!input.progress) {
    return "";
  }

  return [
    `### ${normalizeLine(input.progress.planSummary)}`,
    ...input.progress.completed.map(
      (item) => `- [x] ${normalizeLine(item.title)}`,
    ),
    ...input.progress.unresolved.map(
      (item) =>
        `- ${renderUnresolvedMarker(item.status)} ${normalizeLine(item.title)}`,
    ),
  ].join("\n");
}

function renderUnresolvedMarker(status: string): string {
  return status === "in_progress" ? "[-]" : "[ ]";
}

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
