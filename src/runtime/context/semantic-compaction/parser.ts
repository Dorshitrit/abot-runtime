import {
  SEMANTIC_COMPACTION_DIGEST_MAX_LENGTH,
  SEMANTIC_COMPACTION_DIGEST_TOTAL_MAX_LENGTH,
  SEMANTIC_COMPACTION_LIST_MAX_COUNT,
  SEMANTIC_COMPACTION_TEXT_MAX_LENGTH,
  semanticCompactionContinuationTotalLength,
  type SemanticCompactionContinuation,
  type SemanticCompactionDigest,
  type SemanticCompactionSourceIdentity,
} from "./contracts.js";

export type SemanticCompactionParseResult =
  | Readonly<{
      ok: true;
      continuation: SemanticCompactionContinuation;
      sourceDigests: readonly SemanticCompactionDigest[];
    }>
  | Readonly<{
      ok: false;
      issueCode: SemanticCompactionParseIssueCode;
    }>;

export const SEMANTIC_COMPACTION_PARSE_ISSUE_CODES = Object.freeze([
  "context_compaction_digest_allowance_invalid",
  "context_compaction_output_not_json",
  "context_compaction_output_shape_invalid",
  "context_compaction_continuation_invalid",
  "context_compaction_continuation_length_invalid",
  "context_compaction_sources_invalid",
  "context_compaction_source_invalid",
  "context_compaction_digest_length_invalid",
  "context_compaction_digest_not_semantic",
] as const);

export type SemanticCompactionParseIssueCode =
  (typeof SEMANTIC_COMPACTION_PARSE_ISSUE_CODES)[number];

const CONTINUATION_KEYS = Object.freeze([
  "completed",
  "currentState",
  "findings",
  "evidenceRefs",
  "artifacts",
  "decisions",
  "failedApproaches",
  "openWork",
  "blockers",
  "nextStep",
]);
const SHA256_DIGEST_PATTERN = /^(?:sha256:)?[a-f\d]{64}$/iu;

export function parseSemanticCompactionOutput(
  text: string,
  expectedSources: readonly SemanticCompactionSourceIdentity[],
  digestTotalAllowance = SEMANTIC_COMPACTION_DIGEST_TOTAL_MAX_LENGTH,
): SemanticCompactionParseResult {
  if (
    !Number.isSafeInteger(digestTotalAllowance) ||
    digestTotalAllowance < expectedSources.length ||
    digestTotalAllowance > SEMANTIC_COMPACTION_DIGEST_TOTAL_MAX_LENGTH
  ) {
    return failure("context_compaction_digest_allowance_invalid");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text.trim()) as unknown;
  } catch {
    return failure("context_compaction_output_not_json");
  }
  if (
    !isExactRecord(decoded, ["continuation", "sourceDigests"]) ||
    !isExactRecord(decoded.continuation, CONTINUATION_KEYS)
  ) {
    return failure("context_compaction_output_shape_invalid");
  }
  const continuation = parseContinuation(decoded.continuation);
  if (!continuation) {
    return failure("context_compaction_continuation_invalid");
  }
  if (
    semanticCompactionContinuationTotalLength(continuation) >
    SEMANTIC_COMPACTION_DIGEST_TOTAL_MAX_LENGTH
  ) {
    return failure("context_compaction_continuation_length_invalid");
  }

  const digests = decoded.sourceDigests;
  const expectedRefs = expectedSources.map(({ sourceRef }) => sourceRef);
  const digestMaxLength = Math.min(
    SEMANTIC_COMPACTION_DIGEST_MAX_LENGTH,
    Math.floor(digestTotalAllowance / Math.max(1, expectedRefs.length)),
  );
  if (
    expectedRefs.length === 0 ||
    new Set(expectedRefs).size !== expectedRefs.length ||
    !Array.isArray(digests) ||
    digests.length !== expectedRefs.length
  ) {
    return failure("context_compaction_sources_invalid");
  }
  const sourceDigests: SemanticCompactionDigest[] = [];
  let totalDigestLength = 0;
  for (const [index, digest] of digests.entries()) {
    if (typeof digest !== "string") {
      return failure("context_compaction_source_invalid");
    }
    const normalizedDigest = digest.trim();
    totalDigestLength += normalizedDigest.length;
    if (
      normalizedDigest.length === 0 ||
      normalizedDigest.length > digestMaxLength ||
      totalDigestLength > digestTotalAllowance
    ) {
      return failure("context_compaction_digest_length_invalid");
    }
    const expectedSource = expectedSources[index]!;
    if (
      normalizedDigest === expectedSource.sourceFingerprint ||
      SHA256_DIGEST_PATTERN.test(normalizedDigest)
    ) {
      return failure("context_compaction_digest_not_semantic");
    }
    sourceDigests.push(
      Object.freeze({
        sourceRef: expectedSource.sourceRef,
        sourceFingerprint: expectedSource.sourceFingerprint,
        digest: normalizedDigest,
      }),
    );
  }
  return Object.freeze({
    ok: true as const,
    continuation,
    sourceDigests: Object.freeze(sourceDigests),
  });
}

function parseContinuation(
  value: Record<string, unknown>,
): SemanticCompactionContinuation | undefined {
  const currentState = boundedText(value.currentState);
  const nextStep = boundedText(value.nextStep);
  const completed = boundedTextList(value.completed);
  const findings = boundedTextList(value.findings);
  const evidenceRefs = boundedTextList(value.evidenceRefs);
  const artifacts = boundedTextList(value.artifacts);
  const decisions = boundedTextList(value.decisions);
  const failedApproaches = boundedTextList(value.failedApproaches);
  const openWork = boundedTextList(value.openWork);
  const blockers = boundedTextList(value.blockers);
  if (
    !currentState ||
    !nextStep ||
    !completed ||
    !findings ||
    !evidenceRefs ||
    !artifacts ||
    !decisions ||
    !failedApproaches ||
    !openWork ||
    !blockers
  ) {
    return undefined;
  }
  return Object.freeze({
    completed,
    currentState,
    findings,
    evidenceRefs,
    artifacts,
    decisions,
    failedApproaches,
    openWork,
    blockers,
    nextStep,
  });
}

function boundedText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 &&
    normalized.length <= SEMANTIC_COMPACTION_TEXT_MAX_LENGTH
    ? normalized
    : undefined;
}

function boundedTextList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > SEMANTIC_COMPACTION_LIST_MAX_COUNT) {
    return undefined;
  }
  const entries = value.map(boundedText);
  return entries.some((entry) => entry === undefined)
    ? undefined
    : Object.freeze(entries as string[]);
}

function isExactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function failure(
  issueCode: SemanticCompactionParseIssueCode,
): SemanticCompactionParseResult {
  return Object.freeze({ ok: false as const, issueCode });
}
