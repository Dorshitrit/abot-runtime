const PRIVATE_KEY_MARKER = /-----BEGIN [A-Z ]*PRIVATE KEY-----/iu;
const LABELED_SECRET =
  /\b(?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|recovery[_ -]?code|client[_ -]?secret)\b\s*[:=]\s*\S+/iu;
const COMMON_TOKEN =
  /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/u;

export function containsSensitiveMemoryData(content: string): boolean {
  return (
    PRIVATE_KEY_MARKER.test(content) ||
    LABELED_SECRET.test(content) ||
    COMMON_TOKEN.test(content)
  );
}

export function containsSensitiveMemoryCandidateData(
  candidate: Readonly<{
    content: string;
    tags: readonly string[];
  }>,
): boolean {
  return (
    containsSensitiveMemoryData(candidate.content) ||
    candidate.tags.some(containsSensitiveMemoryData)
  );
}
