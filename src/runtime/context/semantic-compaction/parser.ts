import {
  SEMANTIC_COMPACTION_LIST_MAX_COUNT,
  SEMANTIC_COMPACTION_TEXT_MAX_LENGTH,
  type SemanticCompactionContinuation,
  type SemanticCompactionDigest,
  type SemanticCompactionSourceIdentity,
} from "./contracts.js";
import { bindSemanticCompactionSourceSlots } from "./source-slots.js";

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
  "context_compaction_output_not_json",
  "context_compaction_output_shape_invalid",
  "context_compaction_continuation_invalid",
  "context_compaction_sources_invalid",
  "context_compaction_source_invalid",
  "context_compaction_digest_empty",
  "context_compaction_checkpoint_tokens_exceeded",
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
): SemanticCompactionParseResult {
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
  const digests = decoded.sourceDigests;
  const sourceSlots = bindSemanticCompactionSourceSlots(expectedSources);
  const expectedRefs = expectedSources.map(({ sourceRef }) => sourceRef);
  if (
    expectedRefs.length === 0 ||
    new Set(expectedRefs).size !== expectedRefs.length ||
    !isExactRecord(
      digests,
      sourceSlots.map(({ sourceKey }) => sourceKey),
    )
  ) {
    return failure("context_compaction_sources_invalid");
  }
  const sourceDigests: SemanticCompactionDigest[] = [];
  for (const expectedSource of sourceSlots) {
    const digest = digests[expectedSource.sourceKey];
    if (typeof digest !== "string") {
      return failure("context_compaction_source_invalid");
    }
    const normalizedDigest = digest.trim();
    if (normalizedDigest.length === 0) {
      return failure("context_compaction_digest_empty");
    }
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
  if (
    !Array.isArray(value) ||
    value.length > SEMANTIC_COMPACTION_LIST_MAX_COUNT
  ) {
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
