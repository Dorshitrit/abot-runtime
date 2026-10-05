import { afterEach, describe, expect, test, vi } from "vitest";

import * as logger from "../observability/debug-logger.js";
import {
  createAdmissionController,
  createAdmissionFixture,
  createAdmissionStage,
} from "./support/compaction-admission-fixture.js";

afterEach(() => vi.restoreAllMocks());

describe("compaction finalization and failure ownership", () => {
  test.each([
    "session_memory_source_revision_mismatch",
    "session_memory_checkpoint_revision_mismatch",
    "disk_write_uncertain",
  ])("stops before active commit on %s", async (issue) => {
    const debug = vi
      .spyOn(logger, "traceDebug")
      .mockImplementation(() => undefined);
    const harness = createAdmissionFixture();
    const history = createAdmissionStage("session_history", "history");
    const active = createAdmissionStage("active_request", "active");
    history.commit.mockRejectedValue(new Error(issue));
    await expect(
      harness.run(createAdmissionController([history, active])),
    ).rejects.toThrow(issue);
    expect(history.commit).toHaveBeenCalledOnce();
    expect(active.commit).not.toHaveBeenCalled();
    expect(harness.invoke).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(
      "runtime.context",
      "compaction.failed",
      expect.objectContaining({
        issueCode: issue,
        committedScopes: [],
        commitInProgress: "session_history",
        historyPersistenceOutcome: "unconfirmed",
        candidateInputTokens: 21000,
      }),
    );
  });

  test("preserves committed history when active store rejects without claiming rollback or completion", async () => {
    const debug = vi
      .spyOn(logger, "traceDebug")
      .mockImplementation(() => undefined);
    const harness = createAdmissionFixture();
    const history = createAdmissionStage("session_history", "history");
    const active = createAdmissionStage("active_request", "active");
    let persistedHistory = false;
    history.commit.mockImplementation(async () => {
      persistedHistory = true;
    });
    active.commit.mockImplementation(() => {
      throw new Error("context_compaction_revision_regressed");
    });
    await expect(
      harness.run(createAdmissionController([history, active])),
    ).rejects.toThrow("context_compaction_revision_regressed");
    expect(persistedHistory).toBe(true);
    expect(history.commit).toHaveBeenCalledOnce();
    expect(active.commit).toHaveBeenCalledOnce();
    expect(harness.invoke).not.toHaveBeenCalled();
    expect(
      harness.events.some(([name]) => name === "context.compaction.completed"),
    ).toBe(false);
    expect(debug).toHaveBeenCalledWith(
      "runtime.context",
      "compaction.failed",
      expect.objectContaining({
        committedScopes: ["session_history"],
        commitInProgress: "active_request",
        afterInputTokens: 21000,
      }),
    );
  });

  test.each([
    "history_prepare",
    "history_count",
    "active_prepare",
    "active_count",
    "history_commit",
    "active_commit",
  ] as const)(
    "blocks dispatch and later commits when cancelled at %s",
    async (boundary) => {
      const harness = createAdmissionFixture();
      const history = createAdmissionStage("session_history", "history");
      const active = createAdmissionStage("active_request", "active");
      const cancellation = new Error("request_cancelled");
      const cancel = () => harness.abort.abort(cancellation);
      if (boundary.endsWith("prepare")) {
        const stage = boundary === "history_prepare" ? history : active;
        const prepare = stage.prepare.getMockImplementation()!;
        stage.prepare.mockImplementation(async (messages) => {
          const value = await prepare(messages);
          cancel();
          return value;
        });
      }
      if (boundary.endsWith("count")) {
        const count = harness.countInputTokens.getMockImplementation()!;
        const target = boundary === "history_count" ? 2 : 3;
        harness.countInputTokens.mockImplementation(async (...args) => {
          const result = await count(...args);
          if (harness.countInputTokens.mock.calls.length === target) cancel();
          return result;
        });
      }
      if (boundary === "history_commit")
        history.commit.mockImplementation(async () => cancel());
      if (boundary === "active_commit")
        active.commit.mockImplementation(cancel);

      await expect(
        harness.run(createAdmissionController([history, active])),
      ).rejects.toBe(cancellation);
      expect(harness.invoke).not.toHaveBeenCalled();
      expect(active.commit).toHaveBeenCalledTimes(
        boundary === "active_commit" ? 1 : 0,
      );
      expect(
        harness.events.filter(([name]) => name === "context.compaction.failed"),
      ).toEqual([
        [
          "context.compaction.failed",
          expect.objectContaining({
            issueCode: "request_cancelled",
            reason: "request_aborted",
          }),
        ],
      ]);
    },
  );

  test.each(["prepare", "count", "commit"] as const)(
    "retains cancellation as primary when %s rejects concurrently",
    async (boundary) => {
      const debug = vi
        .spyOn(logger, "traceDebug")
        .mockImplementation(() => undefined);
      const harness = createAdmissionFixture();
      const history = createAdmissionStage("session_history", "history");
      const active = createAdmissionStage("active_request", "active");
      const cancellation = new Error("request_deadline_exceeded");
      const reject = async () => {
        harness.abort.abort(cancellation);
        throw new Error("secondary_failure");
      };
      if (boundary === "prepare") history.prepare.mockImplementation(reject);
      if (boundary === "count")
        harness.countInputTokens
          .mockImplementationOnce(
            harness.countInputTokens.getMockImplementation()!,
          )
          .mockImplementationOnce(reject);
      if (boundary === "commit") history.commit.mockImplementation(reject);
      await expect(
        harness.run(createAdmissionController([history, active])),
      ).rejects.toBe(cancellation);
      expect(active.commit).not.toHaveBeenCalled();
      expect(harness.invoke).not.toHaveBeenCalled();
      expect(debug).toHaveBeenCalledWith(
        "runtime.context",
        "compaction.failed",
        expect.objectContaining({
          issueCode: "request_deadline_exceeded",
          secondaryIssueCode: "secondary_failure",
          ...(boundary === "commit"
            ? { historyPersistenceOutcome: "unconfirmed" }
            : {}),
        }),
      );
    },
  );

  test("does not repeat commits or emit failed after completed delivery throws", async () => {
    const harness = createAdmissionFixture({
      onEvent(name) {
        if (name === "context.compaction.completed")
          throw new Error("delivery_failed");
      },
    });
    const history = createAdmissionStage("session_history", "history");
    const active = createAdmissionStage("active_request", "active");
    await expect(
      harness.run(createAdmissionController([history, active])),
    ).rejects.toThrow("delivery_failed");
    expect(history.commit).toHaveBeenCalledOnce();
    expect(active.commit).toHaveBeenCalledOnce();
    expect(harness.invoke).not.toHaveBeenCalled();
    expect(
      harness.events.filter(([name]) => name.startsWith("context.compaction.")),
    ).toHaveLength(2);
    expect(
      harness.events.some(([name]) => name === "context.compaction.failed"),
    ).toBe(false);
  });

  test("failure delivery does not mask the primary provider error", async () => {
    const harness = createAdmissionFixture({
      onEvent(name) {
        if (name === "context.compaction.failed")
          throw new Error("delivery_failed");
      },
    });
    const active = createAdmissionStage("active_request", "active");
    active.prepare.mockRejectedValue(new Error("provider_failed"));
    await expect(
      harness.run(createAdmissionController([active])),
    ).rejects.toThrow("provider_failed");
    expect(active.commit).not.toHaveBeenCalled();
  });
});
