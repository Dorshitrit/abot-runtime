import type {
  LearningKnowledgeContext,
  LearningKnowledgeEntry,
} from "../../long-term-memory/maturation/contracts.js";
import type { CoWorkerReviewProgress, ReviewProgressPort } from "../review-progress.js";

export const MAX_PROACTIVE_RECEIPTS = 100;
export const MAX_PROACTIVE_STATE_BYTES = 2 * 1024 * 1024;
export const MAX_PROACTIVE_FUTURE_MS = 30 * 86_400_000;

export type ProactiveSourceReference = Readonly<{
  kind: "candidate" | "memory";
  id: string;
  version: string;
}>;
export type ProactiveDecision = Readonly<{
  kind: "none" | "proposal";
  title: string | null;
  message: string | null;
  reason: string;
  sources: readonly ProactiveSourceReference[];
  expiresAt: string | null;
  reconsiderAt: string | null;
}>;
export type ProactiveProposal = Readonly<{
  id: string;
  reviewId: string;
  sessionId: string;
  knowledgeRevision: number;
  title: string;
  message: string;
  reason: string;
  sources: readonly ProactiveSourceReference[];
  createdAt: string;
  expiresAt: string;
  status: "pending" | "delivered" | "dismissed" | "cancelled";
  settledAt: string | null;
}>;
export type ProactiveReviewAttempt = Readonly<{
  reviewId: string;
  knowledgeRevision: number;
  profileId: string;
  status: "running" | "failed";
  method?: "super-v2";
  reason?: string;
}>;
export type ProactiveState = Readonly<{
  schemaVersion: 1;
  revision: number;
  lastReviewId: string | null;
  reviewedKnowledgeRevision: number | null;
  lastReviewedAt: string | null;
  nextReviewAt: string | null;
  deliveryUsage?: Readonly<{ startedAt: number; deliveredCount: number }>;
  reviewAttempt?: ProactiveReviewAttempt;
  reviewProgress?: CoWorkerReviewProgress;
  proposals: readonly ProactiveProposal[];
}>;

/** A crashed or failed paid attempt cannot automatically replay unchanged knowledge. */
export function hasProactiveReviewAttempt(
  state: ProactiveState,
  knowledgeRevision: number,
  profileId: string,
): boolean {
  if (!state.reviewAttempt) return false;
  if (state.reviewAttempt.knowledgeRevision !== knowledgeRevision) return false;
  return state.reviewAttempt.profileId === profileId;
}
export type ProactiveReviewInput = Readonly<{
  reviewId: string;
  modelProfileId: string;
  context: LearningKnowledgeContext;
  recentProposals: readonly ProactiveProposal[];
  signal: AbortSignal;
  progress?: ReviewProgressPort;
}>;

/** Cadence, window and budget remain separate admission gates. */
export function isProactiveReviewEligible(
  input: Readonly<{
    enabled: boolean;
    insideWindow: boolean;
    interactiveBusy: boolean;
    now: number;
    nextAllowedAt: number;
    knowledgeRevision: number;
    hasKnowledge: boolean;
    state: ProactiveState;
  }>,
): boolean {
  if (!input.enabled) return false;
  if (!input.insideWindow) return false;
  if (input.interactiveBusy) return false;
  if (!input.hasKnowledge) return false;
  if (input.now < input.nextAllowedAt) return false;
  if (
    input.state.proposals.some((proposal) =>
      isPendingProposalCurrent(proposal, input.now),
    )
  )
    return false;
  if (input.state.reviewedKnowledgeRevision !== input.knowledgeRevision)
    return true;
  if (!input.state.nextReviewAt) return false;
  return Date.parse(input.state.nextReviewAt) <= input.now;
}

export function isPendingProposalCurrent(
  proposal: ProactiveProposal,
  now: number,
): boolean {
  if (proposal.status !== "pending") return false;
  return Date.parse(proposal.expiresAt) > now;
}

export function canDeliverProactiveProposal(
  input: Readonly<{
    proposal: ProactiveProposal;
    enabled: boolean;
    insideWindow: boolean;
    generationCurrent: boolean;
    now: number;
    currentSources: readonly ProactiveSourceReference[];
  }>,
): boolean {
  if (!input.enabled) return false;
  if (!input.insideWindow) return false;
  if (!input.generationCurrent) return false;
  if (!isPendingProposalCurrent(input.proposal, input.now)) return false;
  if (!input.proposal.sources.length) return false;
  return input.proposal.sources.every((source) =>
    hasExactProactiveSource(input.currentSources, source),
  );
}

export function hasExactProactiveSource(
  entries: readonly Pick<LearningKnowledgeEntry, "kind" | "id" | "version">[],
  source: ProactiveSourceReference,
): boolean {
  return entries.some(
    (entry) =>
      entry.kind === source.kind &&
      entry.id === source.id &&
      entry.version === source.version,
  );
}

export function validateProactiveDecision(
  value: unknown,
  entries: readonly ProactiveSourceReference[],
  now: number,
): ProactiveDecision {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("proactive_decision_invalid");
  const decision = value as ProactiveDecision;
  if (decision.kind !== "none" && decision.kind !== "proposal")
    throw new Error("proactive_decision_invalid");
  if (!isBoundedProactiveText(decision.reason, 1000))
    throw new Error("proactive_reason_invalid");
  if (!Array.isArray(decision.sources) || decision.sources.length > 12)
    throw new Error("proactive_sources_invalid");
  const sources = decision.sources.map((source) => {
    if (!source || typeof source !== "object")
      throw new Error("proactive_source_invalid");
    if (!hasExactProactiveSource(entries, source))
      throw new Error("proactive_source_stale_or_unknown");
    return Object.freeze({
      kind: source.kind,
      id: source.id,
      version: source.version,
    });
  });
  if (
    new Set(sources.map((source) => `${source.kind}:${source.id}`)).size !==
    sources.length
  )
    throw new Error("proactive_source_duplicate");
  validateProactiveFutureInstant(decision.reconsiderAt, now);
  if (decision.kind === "none") {
    if (
      decision.title !== null ||
      decision.message !== null ||
      decision.expiresAt !== null ||
      sources.length
    )
      throw new Error("proactive_none_payload_invalid");
    return Object.freeze({
      kind: decision.kind,
      title: null,
      message: null,
      reason: decision.reason,
      sources,
      expiresAt: null,
      reconsiderAt: decision.reconsiderAt,
    });
  }
  if (!isBoundedProactiveText(decision.title, 160))
    throw new Error("proactive_title_invalid");
  if (!isBoundedProactiveText(decision.message, 4000))
    throw new Error("proactive_message_invalid");
  if (!sources.length) throw new Error("proactive_sources_required");
  if (decision.expiresAt === null) throw new Error("proactive_expiry_required");
  validateProactiveFutureInstant(decision.expiresAt, now);
  return Object.freeze({
    kind: decision.kind,
    title: decision.title,
    message: decision.message,
    reason: decision.reason,
    sources,
    expiresAt: decision.expiresAt,
    reconsiderAt: decision.reconsiderAt,
  });
}

export function validateProactiveFutureInstant(
  value: unknown,
  now: number,
): void {
  if (!Number.isFinite(now))
    throw new Error("proactive_reference_time_invalid");
  if (value === null) return;
  if (typeof value !== "string") throw new Error("proactive_time_invalid");
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) throw new Error("proactive_time_invalid");
  if (instant <= now) throw new Error("proactive_time_not_future");
  if (instant - now > MAX_PROACTIVE_FUTURE_MS)
    throw new Error("proactive_time_too_distant");
}

export function isBoundedProactiveText(
  value: unknown,
  maximum: number,
): value is string {
  if (typeof value !== "string") return false;
  if (!value.trim()) return false;
  return value.length <= maximum;
}
