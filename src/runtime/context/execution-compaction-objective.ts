import { createSemanticCompactionSha256Fingerprint } from "./semantic-compaction/contracts.js";

/** One accepted request objective shared by EA and its evidence consumers. */
export function projectExecutionCompactionObjective(
  prompt: string,
  updates: readonly Readonly<{ text: string }>[],
): string {
  return [prompt, ...updates.map(({ text }) => text)].join("\n");
}

/** A changed objective gets a fresh lane; prior checkpoints retain their binding. */
export function executionCompactionScopeId(
  params: Readonly<{
    callId: string;
    prompt: string;
    objective: string;
    scopeSuffix?: string;
  }>,
): string {
  const scope = `role:supervisor:${params.callId}:${params.scopeSuffix ?? "continuation"}`;
  if (params.objective === params.prompt) return scope;
  return `${scope}:objective:${createSemanticCompactionSha256Fingerprint(params.objective)}`;
}
