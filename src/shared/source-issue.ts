/** Process-local causal metadata; never inferred from provider text or request history. */
const sourceIssues = new WeakMap<Error, string>();

export function isSourceIssueId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/u.test(value);
}

export function attachSourceIssueId<T extends Error>(error: T, issueId: string): T {
  if (isSourceIssueId(issueId) && !sourceIssues.has(error)) sourceIssues.set(error, issueId);
  return error;
}

export function readSourceIssueId(error: unknown): string | undefined {
  const visited = new Set<Error>();
  while (error instanceof Error && visited.size < 8 && !visited.has(error)) {
    visited.add(error);
    const issueId = sourceIssues.get(error);
    if (issueId) return issueId;
    error = error.cause;
  }
  return undefined;
}

export function sourceIssueDetails(error: unknown): { sourceIssueId?: string } {
  const sourceIssueId = readSourceIssueId(error);
  return sourceIssueId ? { sourceIssueId } : {};
}
