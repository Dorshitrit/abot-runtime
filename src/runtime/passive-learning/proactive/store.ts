import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "../../adapters/long-term-memory/file-lock.js";
import { fileSystemErrorCode } from "../../adapters/long-term-memory/file-lock/contracts.js";
import { readCoWorkerReviewProgress } from "../review-progress.js";
import { createProactiveReviewProgressStore } from "./staged-progress-store.js";
import {
  isBoundedProactiveText,
  isPendingProposalCurrent,
  MAX_PROACTIVE_RECEIPTS,
  MAX_PROACTIVE_STATE_BYTES,
  hasProactiveReviewAttempt,
  validateProactiveDecision,
  validateProactiveFutureInstant,
  type ProactiveDecision,
  type ProactiveProposal,
  type ProactiveReviewAttempt,
  type ProactiveState,
} from "./contracts.js";

const EMPTY_STATE: ProactiveState = Object.freeze({
  schemaVersion: 1,
  revision: 0,
  lastReviewId: null,
  reviewedKnowledgeRevision: null,
  lastReviewedAt: null,
  nextReviewAt: null,
  proposals: Object.freeze([]),
});

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function safeAttemptReason(value: unknown): string {
  if (typeof value !== "string") return "proactive_failed";
  return /^[a-z][a-z0-9_]{0,100}$/u.test(value) ? value : "proactive_failed";
}
function parseReviewAttempt(value: unknown): ProactiveReviewAttempt {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("proactive_state_invalid");
  const attempt = value as ProactiveReviewAttempt;
  if (!isBoundedProactiveText(attempt.reviewId, 160))
    throw new Error("proactive_state_invalid");
  if (!isBoundedProactiveText(attempt.profileId, 128))
    throw new Error("proactive_state_invalid");
  if (
    !Number.isSafeInteger(attempt.knowledgeRevision) ||
    attempt.knowledgeRevision < 0
  )
    throw new Error("proactive_state_invalid");
  if (attempt.status !== "running" && attempt.status !== "failed")
    throw new Error("proactive_state_invalid");
  if (attempt.method !== undefined && attempt.method !== "super-v2") throw new Error("proactive_state_invalid");
  return {
    reviewId: attempt.reviewId,
    knowledgeRevision: attempt.knowledgeRevision,
    profileId: attempt.profileId,
    status: attempt.status,
    ...(attempt.method ? { method: attempt.method } : {}),
    ...(attempt.reason === undefined
      ? {}
      : { reason: safeAttemptReason(attempt.reason) }),
  };
}
function withoutReviewAttempt(state: ProactiveState): ProactiveState {
  const { reviewAttempt: _reviewAttempt, reviewProgress: _reviewProgress, ...rest } = state;
  return rest;
}
function parseProposal(value: unknown): ProactiveProposal {
  if (!value || typeof value !== "object")
    throw new Error("proactive_state_invalid");
  const item = value as ProactiveProposal;
  if (
    ![item.id, item.reviewId, item.sessionId].every((id) =>
      isBoundedProactiveText(id, 160),
    )
  )
    throw new Error("proactive_state_invalid");
  if (
    !Number.isSafeInteger(item.knowledgeRevision) ||
    item.knowledgeRevision < 0
  )
    throw new Error("proactive_state_invalid");
  if (!["pending", "delivered", "dismissed", "cancelled"].includes(item.status))
    throw new Error("proactive_state_invalid");
  if (!validTimestamp(item.createdAt))
    throw new Error("proactive_state_invalid");
  if (item.settledAt !== null && !validTimestamp(item.settledAt))
    throw new Error("proactive_state_invalid");
  if (!Array.isArray(item.sources) || item.sources.length > 12)
    throw new Error("proactive_state_invalid");
  for (const source of item.sources) {
    if (!source || typeof source !== "object")
      throw new Error("proactive_state_invalid");
    if (source.kind !== "candidate" && source.kind !== "memory")
      throw new Error("proactive_state_invalid");
    if (
      !isBoundedProactiveText(source.id, 160) ||
      !isBoundedProactiveText(source.version, 160)
    )
      throw new Error("proactive_state_invalid");
  }
  const decision = validateProactiveDecision(
    {
      kind: "proposal",
      title: item.title,
      message: item.message,
      reason: item.reason,
      sources: item.sources,
      expiresAt: item.expiresAt,
      reconsiderAt: null,
    },
    item.sources,
    Date.parse(item.createdAt),
  );
  return Object.freeze({
    id: item.id,
    reviewId: item.reviewId,
    sessionId: item.sessionId,
    knowledgeRevision: item.knowledgeRevision,
    title: decision.title!,
    message: decision.message!,
    reason: decision.reason,
    sources: decision.sources,
    createdAt: item.createdAt,
    expiresAt: decision.expiresAt!,
    status: item.status,
    settledAt: item.settledAt,
  });
}
function parseState(value: unknown): ProactiveState {
  if (!value || typeof value !== "object")
    throw new Error("proactive_state_invalid");
  const state = value as ProactiveState;
  if (
    state.schemaVersion !== 1 ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0
  )
    throw new Error("proactive_state_invalid");
  if (
    state.lastReviewId !== null &&
    !isBoundedProactiveText(state.lastReviewId, 160)
  )
    throw new Error("proactive_state_invalid");
  if (
    state.reviewedKnowledgeRevision !== null &&
    (!Number.isSafeInteger(state.reviewedKnowledgeRevision) ||
      state.reviewedKnowledgeRevision < 0)
  )
    throw new Error("proactive_state_invalid");
  if (state.lastReviewedAt !== null && !validTimestamp(state.lastReviewedAt))
    throw new Error("proactive_state_invalid");
  if (state.nextReviewAt !== null && !validTimestamp(state.nextReviewAt))
    throw new Error("proactive_state_invalid");
  if (
    state.deliveryUsage &&
    (!Number.isFinite(state.deliveryUsage.startedAt) ||
      !Number.isSafeInteger(state.deliveryUsage.deliveredCount) ||
      state.deliveryUsage.deliveredCount < 0)
  )
    throw new Error("proactive_state_invalid");
  if (
    !Array.isArray(state.proposals) ||
    state.proposals.length > MAX_PROACTIVE_RECEIPTS
  )
    throw new Error("proactive_state_invalid");
  const proposals = state.proposals.map(parseProposal);
  if (new Set(proposals.map(({ id }) => id)).size !== proposals.length)
    throw new Error("proactive_state_invalid");
  return Object.freeze({
    schemaVersion: 1,
    revision: state.revision,
    lastReviewId: state.lastReviewId,
    reviewedKnowledgeRevision: state.reviewedKnowledgeRevision,
    lastReviewedAt: state.lastReviewedAt,
    nextReviewAt: state.nextReviewAt,
    proposals: Object.freeze(proposals),
    ...(state.reviewAttempt === undefined
      ? {}
      : { reviewAttempt: parseReviewAttempt(state.reviewAttempt) }),
    ...(state.reviewProgress === undefined
      ? {}
      : { reviewProgress: readCoWorkerReviewProgress(state.reviewProgress) }),
    ...(state.deliveryUsage
      ? { deliveryUsage: { ...state.deliveryUsage } }
      : {}),
  });
}
function proposalFromDecision(input: {
  reviewId: string;
  knowledgeRevision: number;
  decision: ProactiveDecision;
  now: number;
}): ProactiveProposal {
  const id = createHash("sha256")
    .update(`co-worker-proposal:${input.reviewId}`)
    .digest("hex");
  const { decision } = input;
  return {
    id,
    reviewId: input.reviewId,
    sessionId: `co-worker-${id}`,
    knowledgeRevision: input.knowledgeRevision,
    title: decision.title!,
    message: decision.message!,
    reason: decision.reason,
    sources: decision.sources,
    createdAt: new Date(input.now).toISOString(),
    expiresAt: decision.expiresAt!,
    status: "pending",
    settledAt: null,
  };
}

/** This store records decisions, not session mutations or user permissions. */
export function createProactiveStateStore(directory: string) {
  const file = join(directory, "proactive.json");
  async function read(): Promise<ProactiveState> {
    try {
      const handle = await open(file, "r");
      try {
        const buffer = Buffer.alloc(MAX_PROACTIVE_STATE_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_PROACTIVE_STATE_BYTES)
          throw new Error("proactive_state_too_large");
        return parseState(
          JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")),
        );
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (fileSystemErrorCode(error) === "ENOENT") return EMPTY_STATE;
      throw error;
    }
  }
  async function update(
    change: (current: ProactiveState) => ProactiveState,
  ): Promise<ProactiveState> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return withFileLock(`${file}.lock`, async () => {
      const previous = await read();
      const changed = change(previous);
      if (changed === previous) return previous;
      const next = parseState({ ...changed, revision: previous.revision + 1 });
      const serialized = JSON.stringify(next);
      if (Buffer.byteLength(serialized) > MAX_PROACTIVE_STATE_BYTES)
        throw new Error("proactive_state_too_large");
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(serialized);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
      return next;
    });
  }
  function settle(
    id: string,
    status: "delivered" | "dismissed",
    now: number,
    startedAt?: number,
  ): Promise<ProactiveState> {
    return update((current) => {
      const target = current.proposals.find((item) => item.id === id);
      if (!target) throw new Error("proactive_proposal_unknown");
      if (target.status === status) return current;
      if (target.status === "cancelled" || target.status === "dismissed")
        return current;
      const deliveryUsage =
        status === "delivered" && startedAt !== undefined
          ? {
              startedAt,
              deliveredCount: countProactiveDeliveries(current, startedAt) + 1,
            }
          : current.deliveryUsage;
      return {
        ...current,
        ...(deliveryUsage ? { deliveryUsage } : {}),
        proposals: current.proposals.map((item) =>
          item.id !== id
            ? item
            : {
                ...item,
                status,
                settledAt: item.settledAt ?? new Date(now).toISOString(),
              },
        ),
      };
    });
  }
  return Object.freeze({
    read,
    ...createProactiveReviewProgressStore(update),
    async reserveReviewAttempt(
      input: Readonly<{
        reviewId: string;
        expectedRevision: number;
        knowledgeRevision: number;
        profileId: string;
        method?: "super-v2";
        now: number;
        assertCurrent(): void;
      }>,
    ): Promise<ProactiveState | undefined> {
      let reserved = false;
      const result = await update((current) => {
        input.assertCurrent();
        if (!Number.isFinite(input.now))
          throw new Error("proactive_reference_time_invalid");
        const attempt = parseReviewAttempt({
          reviewId: input.reviewId,
          knowledgeRevision: input.knowledgeRevision,
          profileId: input.profileId,
          status: "running",
          ...(input.method ? { method: input.method } : {}),
        });
        if (current.lastReviewId === input.reviewId) return current;
        if (
          current.proposals.some(
            (proposal) => proposal.reviewId === input.reviewId,
          )
        )
          return current;
        if (current.reviewAttempt?.reviewId === input.reviewId) return current;
        if (
          hasProactiveReviewAttempt(
            current,
            input.knowledgeRevision,
            input.profileId,
          )
        )
          return current;
        if (current.revision !== input.expectedRevision)
          throw new Error("proactive_revision_conflict");
        reserved = true;
        return { ...current, reviewAttempt: attempt };
      });
      return reserved ? result : undefined;
    },
    failReviewAttempt(
      reviewId: string,
      reason: string,
      retryable: boolean,
    ): Promise<ProactiveState> {
      return update((current) => {
        if (current.reviewAttempt?.reviewId !== reviewId) return current;
        if (retryable) return withoutReviewAttempt(current);
        const safeReason = safeAttemptReason(reason);
        if (
          current.reviewAttempt.status === "failed" &&
          current.reviewAttempt.reason === safeReason
        )
          return current;
        return {
          ...current,
          reviewAttempt: {
            ...current.reviewAttempt,
            status: "failed",
            reason: safeReason,
          },
        };
      });
    },
    clearReviewAttempt(): Promise<ProactiveState> {
      return update((current) =>
        current.reviewAttempt ? withoutReviewAttempt(current) : current,
      );
    },
    commitReview(
      input: Readonly<{
        reviewId: string;
        expectedRevision: number;
        knowledgeRevision: number;
        decision: ProactiveDecision;
        now: number;
        assertCurrent?(): void;
      }>,
    ): Promise<ProactiveState> {
      return update((current) => {
        input.assertCurrent?.();
        if (current.lastReviewId === input.reviewId) return current;
        if (
          current.proposals.some(
            (proposal) => proposal.reviewId === input.reviewId,
          )
        )
          return current;
        if (current.revision !== input.expectedRevision)
          throw new Error("proactive_revision_conflict");
        if (
          current.reviewAttempt &&
          current.reviewAttempt.reviewId !== input.reviewId
        )
          throw new Error("proactive_review_attempt_conflict");
        if (
          current.reviewAttempt &&
          current.reviewAttempt.knowledgeRevision !== input.knowledgeRevision
        )
          throw new Error("proactive_review_attempt_conflict");
        if (current.reviewAttempt?.status === "failed")
          throw new Error("proactive_review_attempt_conflict");
        if (!isBoundedProactiveText(input.reviewId, 160))
          throw new Error("proactive_review_id_invalid");
        validateProactiveDecision(
          input.decision,
          input.decision.sources,
          input.now,
        );
        validateProactiveFutureInstant(input.decision.reconsiderAt, input.now);
        if (
          current.proposals.some((proposal) =>
            isPendingProposalCurrent(proposal, input.now),
          )
        )
          throw new Error("proactive_pending_proposal_exists");
        const proposals = [...current.proposals];
        if (input.decision.kind === "proposal")
          proposals.push(proposalFromDecision(input));
        return {
          ...withoutReviewAttempt(current),
          lastReviewId: input.reviewId,
          reviewedKnowledgeRevision: input.knowledgeRevision,
          lastReviewedAt: new Date(input.now).toISOString(),
          nextReviewAt: input.decision.reconsiderAt,
          proposals: proposals.slice(-MAX_PROACTIVE_RECEIPTS),
        };
      });
    },
    markDelivered: (id: string, now: number, startedAt?: number) =>
      settle(id, "delivered", now, startedAt),
    dismiss: (id: string, now: number) => settle(id, "dismissed", now),
    cancelPending(now: number): Promise<ProactiveState> {
      return update((current) => {
        if (
          !current.proposals.some((proposal) => proposal.status === "pending")
        )
          return current;
        return {
          ...current,
          proposals: current.proposals.map((proposal) =>
            proposal.status !== "pending"
              ? proposal
              : {
                  ...proposal,
                  status: "cancelled",
                  settledAt: new Date(now).toISOString(),
                },
          ),
        };
      });
    },
  });
}

/** Daily counters outlive the bounded proposal list; dismissing does not refund delivery. */
export function countProactiveDeliveries(
  state: ProactiveState,
  startedAt: number,
): number {
  if (state.deliveryUsage?.startedAt === startedAt)
    return state.deliveryUsage.deliveredCount;
  return state.proposals.filter(
    (proposal) =>
      (proposal.status === "delivered" || proposal.status === "dismissed") &&
      proposal.settledAt !== null &&
      Date.parse(proposal.settledAt) >= startedAt,
  ).length;
}
