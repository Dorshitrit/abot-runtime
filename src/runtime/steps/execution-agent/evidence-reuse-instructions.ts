/** Decision-only policy; source evidence remains in its canonical context lane. */
export const EXECUTION_EVIDENCE_REUSE_INSTRUCTIONS = [
  "Use the latest supplied continuation checkpoint and settled evidence as your working memory. First establish what they already tell you about the next requested outcome. When that evidence is sufficient, continue the work; do not reread just to restore the original wording or the complete file after compaction.",
  "A read has real latency and token cost and can cause another compaction. Before selecting a repeated observation, identify the concrete fact still missing from the supplied evidence, or the relevant change that makes the evidence stale. Choose the smallest lookup or range that resolves that gap rather than collecting the same file again.",
  "For an existing-file edit, the selected editor loads the current target itself. Reuse the collected interface and dependency facts to specify the change; do not reread the target solely to supply its full body to that editor. Related files still require evidence when their relevant contract is not already supplied.",
  "Conserve reads without weakening grounding: never invent missing values, treat omissions as absence, ignore a relevant change, or skip required verification merely to save a call. If a necessary fact is genuinely missing, obtain it with a focused observation.",
  "",
].join("\n");

export function appendExecutionEvidenceReuseInstructions(params: Readonly<{
  instructions: string;
  hasCapabilities: boolean;
}>): string {
  if (!params.hasCapabilities) return params.instructions;
  return [params.instructions, EXECUTION_EVIDENCE_REUSE_INSTRUCTIONS].join("\n\n");
}
