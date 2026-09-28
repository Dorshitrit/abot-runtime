import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  hasProactiveReviewAttempt,
  type ProactiveDecision,
} from "../passive-learning/proactive/contracts.js";
import { createProactiveStateStore } from "../passive-learning/proactive/store.js";

const NOW = Date.parse("2026-09-25T12:00:00Z");
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function directory() {
  const parent = join(
    process.cwd(),
    ".codex/artifacts/co-worker-proactive-attempt-tests",
  );
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "fixture-"));
  roots.push(root);
  return root;
}
function reservation(reviewId = "r1", expectedRevision = 0) {
  return {
    reviewId,
    expectedRevision,
    knowledgeRevision: 4,
    profileId: "local",
    now: NOW,
    assertCurrent: () => {},
  };
}
const NONE: ProactiveDecision = {
  kind: "none",
  title: null,
  message: null,
  reason: "Nothing to propose",
  sources: [],
  expiresAt: null,
  reconsiderAt: null,
};

describe("durable proactive attempt receipt", () => {
  test("a running attempt survives restart and blocks unchanged knowledge without another write", async () => {
    const root = await directory();
    const first =
      await createProactiveStateStore(root).reserveReviewAttempt(reservation());
    expect(first).toMatchObject({
      revision: 1,
      reviewAttempt: {
        reviewId: "r1",
        knowledgeRevision: 4,
        profileId: "local",
        status: "running",
      },
    });
    const before = await stat(join(root, "proactive.json"));
    const restarted = createProactiveStateStore(root);
    expect(
      await restarted.reserveReviewAttempt(reservation("r2", first!.revision)),
    ).toBeUndefined();
    expect(hasProactiveReviewAttempt(await restarted.read(), 4, "local")).toBe(
      true,
    );
    expect(hasProactiveReviewAttempt(await restarted.read(), 5, "local")).toBe(
      false,
    );
    expect((await stat(join(root, "proactive.json"))).mtimeMs).toBe(
      before.mtimeMs,
    );
  });

  test("failed output is one bounded receipt and exposes only a safe reason code", async () => {
    const root = await directory();
    const store = createProactiveStateStore(root);
    await store.reserveReviewAttempt(reservation());
    const failed = await store.failReviewAttempt(
      "r1",
      "Provider body and /private/path",
      false,
    );
    expect(failed.reviewAttempt).toMatchObject({
      status: "failed",
      reason: "proactive_failed",
    });
    const file = await readFile(join(root, "proactive.json"), "utf8");
    expect(file).not.toContain("private/path");
    expect(file.length).toBeLessThan(1000);
    const before = await stat(join(root, "proactive.json"));
    expect(
      await store.failReviewAttempt(
        "r1",
        "Provider body and /private/path",
        false,
      ),
    ).toEqual(failed);
    expect(
      await createProactiveStateStore(root).reserveReviewAttempt(
        reservation("r2", failed.revision),
      ),
    ).toBeUndefined();
    expect((await stat(join(root, "proactive.json"))).mtimeMs).toBe(
      before.mtimeMs,
    );
  });

  test("retryable control and budget failures release the receipt, while explicit reset permits a failed retry", async () => {
    const store = createProactiveStateStore(await directory());
    await store.reserveReviewAttempt(reservation());
    const released = await store.failReviewAttempt(
      "r1",
      "co_worker_model_daily_budget_exhausted",
      true,
    );
    expect(released.reviewAttempt).toBeUndefined();
    const retried = await store.reserveReviewAttempt(
      reservation("r2", released.revision),
    );
    expect(retried?.reviewAttempt?.reviewId).toBe("r2");
    await store.failReviewAttempt("r2", "proactive_decision_invalid", false);
    const reset = await store.clearReviewAttempt();
    expect(reset.reviewAttempt).toBeUndefined();
    expect(await store.clearReviewAttempt()).toEqual(reset);
    expect(
      await store.reserveReviewAttempt(reservation("r3", reset.revision)),
    ).toBeDefined();
  });

  test.each([{ knowledgeRevision: 5 }, { profileId: "cloud" }])(
    "new knowledge or model selection can replace the previous attempt (%j)",
    async (changed) => {
      const store = createProactiveStateStore(await directory());
      const first = await store.reserveReviewAttempt(reservation());
      const next = await store.reserveReviewAttempt({
        ...reservation("r2", first!.revision),
        ...changed,
      });
      expect(next?.reviewAttempt).toMatchObject({ reviewId: "r2", ...changed });
      expect(
        await store.failReviewAttempt(
          "r1",
          "proactive_decision_invalid",
          false,
        ),
      ).toEqual(next);
      expect(await store.failReviewAttempt("r1", "aborted", true)).toEqual(
        next,
      );
    },
  );

  test("competing reservations use one atomic revision and late disable prevents admission", async () => {
    const root = await directory();
    const one = createProactiveStateStore(root);
    const two = createProactiveStateStore(root);
    const attempts = await Promise.all([
      one.reserveReviewAttempt(reservation("one")),
      two.reserveReviewAttempt(reservation("two")),
    ]);
    expect(attempts.filter(Boolean)).toHaveLength(1);
    const current = await one.read();
    await expect(
      one.reserveReviewAttempt({
        ...reservation("stale"),
        knowledgeRevision: 5,
      }),
    ).rejects.toThrow("proactive_revision_conflict");
    await expect(
      one.reserveReviewAttempt({
        ...reservation("late", current.revision),
        knowledgeRevision: 5,
        assertCurrent: () => {
          throw new Error("explicitly_disabled");
        },
      }),
    ).rejects.toThrow("explicitly_disabled");
    expect(await one.read()).toEqual(current);
  });

  test("only matching successful commits clear a running receipt, with old direct commits still supported", async () => {
    const store = createProactiveStateStore(await directory());
    const initial = await store.read();
    expect(initial.reviewAttempt).toBeUndefined();
    const legacy = await store.commitReview({
      reviewId: "old",
      expectedRevision: initial.revision,
      knowledgeRevision: 3,
      decision: NONE,
      now: NOW,
    });
    const admitted = await store.reserveReviewAttempt(
      reservation("new", legacy.revision),
    );
    const input = {
      reviewId: "new",
      expectedRevision: admitted!.revision,
      knowledgeRevision: 4,
      decision: NONE,
      now: NOW,
    };
    await expect(
      store.commitReview({ ...input, reviewId: "other" }),
    ).rejects.toThrow("proactive_review_attempt_conflict");
    await expect(
      store.commitReview({ ...input, knowledgeRevision: 5 }),
    ).rejects.toThrow("proactive_review_attempt_conflict");
    const committed = await store.commitReview(input);
    expect(committed.reviewAttempt).toBeUndefined();
    expect(committed.reviewedKnowledgeRevision).toBe(4);
    expect(await store.commitReview(input)).toEqual(committed);
    expect(
      await store.reserveReviewAttempt(reservation("new", committed.revision)),
    ).toBeUndefined();
  });

  test("failed or malformed receipts cannot accept a late result or corrupt the stored binding", async () => {
    const root = await directory();
    const store = createProactiveStateStore(root);
    await store.reserveReviewAttempt(reservation());
    const failed = await store.failReviewAttempt(
      "r1",
      "proactive_decision_invalid",
      false,
    );
    await expect(
      store.commitReview({
        reviewId: "r1",
        expectedRevision: failed.revision,
        knowledgeRevision: 4,
        decision: NONE,
        now: NOW,
      }),
    ).rejects.toThrow("proactive_review_attempt_conflict");
    await writeFile(
      join(root, "proactive.json"),
      JSON.stringify({
        ...failed,
        reviewAttempt: { ...failed.reviewAttempt, knowledgeRevision: -1 },
      }),
    );
    await expect(store.read()).rejects.toThrow("proactive_state_invalid");
  });
});
