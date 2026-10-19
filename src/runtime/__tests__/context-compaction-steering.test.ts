import { afterEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";

import { ModelStepSteeringSupersededError } from "../model/model-step-steering.js";
import { ModelStepTimeoutError } from "../steps/model-step-timeout.js";
import { createRealtimeContextHarness } from "./support/realtime-context-harness.js";
import {
  ADMISSION_MESSAGES,
  createAdmissionController,
  createAdmissionFixture,
  createAdmissionStage,
} from "./support/compaction-admission-fixture.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const BOUNDARIES = [
  "initial_count",
  "history_prepare",
  "history_count",
  "active_prepare",
  "active_count",
  "history_commit",
  "active_commit",
] as const;
type Boundary = (typeof BOUNDARIES)[number];

describe("admission steering freshness", () => {
  test("clears the Web UI pending state when the fresh attempt needs no new compaction", async () => {
    const fixture = createSteeringFixture("history_prepare");
    await fixture.harness.run(fixture.controller);
    const ui = createRealtimeContextHarness();
    ui.state.activeRequestId = "staged-admission";
    for (const [index, [name, extra]] of fixture.harness.events.entries()) {
      ui.controller.handle({
        type: "event",
        name,
        ...extra,
        eventSequence: index + 1,
        seqNo: index + 1,
      });
      const pending =
        ui.state.contextWindowByRequest.get(
          "staged-admission",
        )?.pendingCompaction;
      if (name === "context.compaction.started") expect(pending).not.toBeNull();
      if (name === "context.compaction.failed") expect(pending).toBeNull();
    }
    expect(
      ui.state.contextWindowByRequest.get("staged-admission")
        ?.pendingCompaction,
    ).toBeNull();
    expect(
      fixture.harness.events.filter(
        ([name]) => name === "context.compaction.started",
      ),
    ).toHaveLength(1);
  });

  test.each(BOUNDARIES)(
    "returns bound stale decisions to their owner after %s",
    async (boundary) => {
      const fixture = createSteeringFixture(boundary);
      await expect(
        fixture.harness.run(fixture.controller, 0),
      ).rejects.toBeInstanceOf(ModelStepSteeringSupersededError);
      expect(fixture.harness.invoke).not.toHaveBeenCalled();
      expect(fixture.controller.project).toHaveBeenCalledOnce();
      expect(fixture.active.commit).toHaveBeenCalledTimes(
        boundary === "active_commit" ? 1 : 0,
      );
      assertSupersededLifecycle(fixture.harness, boundary);
    },
  );

  test.each(BOUNDARIES)(
    "restarts unbound root from original params after %s with one closed compaction cycle",
    async (boundary) => {
      const fixture = createSteeringFixture(boundary);
      await expect(fixture.harness.run(fixture.controller)).resolves.toBe("ok");
      expect(fixture.harness.invoke).toHaveBeenCalledOnce();
      expect(fixture.controller.project).toHaveBeenCalledTimes(2);
      expect(fixture.controller.project.mock.calls[1]![0]).toEqual(
        ADMISSION_MESSAGES,
      );
      expect(
        (
          fixture.harness.invoke.mock.calls[0]![0]
            .messages as readonly ChatMessage[]
        ).at(-1)?.content,
      ).toContain("new direction");
      expect(fixture.history.prepare.mock.calls.length).toBeLessThanOrEqual(1);
      expect(fixture.active.prepare.mock.calls.length).toBeLessThanOrEqual(1);
      assertSupersededLifecycle(fixture.harness, boundary);
    },
  );

  test.each(BOUNDARIES)(
    "defers steering for an unbound child after %s without changing assignment",
    async (boundary) => {
      const fixture = createSteeringFixture(boundary, true);
      await expect(fixture.harness.run(fixture.controller)).resolves.toBe("ok");
      expect(fixture.harness.invoke).toHaveBeenCalledOnce();
      expect(fixture.controller.project).toHaveBeenCalledOnce();
      expect(fixture.history.commit).toHaveBeenCalledOnce();
      expect(fixture.active.commit).toHaveBeenCalledOnce();
      expect(
        JSON.stringify(fixture.harness.invoke.mock.calls[0]![0].messages),
      ).not.toContain("new direction");
      expect(
        fixture.harness.events.some(
          ([name]) => name === "context.compaction.failed",
        ),
      ).toBe(false);
    },
  );

  test.each(["prepare", "count", "commit"] as const)(
    "preserves a real %s rejection even if steering changed",
    async (boundary) => {
      const harness = createAdmissionFixture();
      const history = createAdmissionStage("session_history", "history");
      const active = createAdmissionStage("active_request", "active");
      const fail = async () => {
        harness.steering.append({ steerId: "one", text: "new direction" });
        throw new Error("real_failure");
      };
      if (boundary === "prepare") history.prepare.mockImplementation(fail);
      if (boundary === "count")
        harness.countInputTokens
          .mockImplementationOnce(
            harness.countInputTokens.getMockImplementation()!,
          )
          .mockImplementationOnce(fail);
      if (boundary === "commit") history.commit.mockImplementation(fail);
      const controller = createAdmissionController([history, active]);
      await expect(harness.run(controller)).rejects.toThrow("real_failure");
      expect(controller.project).toHaveBeenCalledOnce();
      expect(harness.invoke).not.toHaveBeenCalled();
      expect(active.commit).not.toHaveBeenCalled();
      expect(harness.events).toContainEqual([
        "context.compaction.failed",
        expect.objectContaining({
          issueCode: "real_failure",
          reason: "semantic_checkpoint_rejected",
        }),
      ]);
    },
  );

  test("does not emit a second terminal if steering arrives during completed delivery", async () => {
    const harness = createAdmissionFixture({
      onEvent(name) {
        if (name === "context.compaction.completed")
          harness.steering.append({ steerId: "one", text: "new direction" });
      },
    });
    const history = createAdmissionStage("session_history", "history");
    const active = createAdmissionStage("active_request", "active");
    await harness.run(createAdmissionController([history, active]));
    expect(history.commit).toHaveBeenCalledOnce();
    expect(active.commit).toHaveBeenCalledOnce();
    expect(harness.invoke).toHaveBeenCalledOnce();
    expect(
      harness.events.filter(([name]) => name.startsWith("context.compaction.")),
    ).toHaveLength(2);
    expect(
      harness.events.some(([name]) => name === "context.compaction.failed"),
    ).toBe(false);
  });

  test("disposes an attempt superseded after admission returns, before provider dispatch", async () => {
    vi.useFakeTimers();
    let snapshots = 0;
    const harness = createAdmissionFixture({
      counts: [1000, 1000],
      onEvent(name) {
        if (name !== "context.window.snapshot") return;
        snapshots += 1;
        if (snapshots === 1)
          harness.steering.append({ steerId: "one", text: "new direction" });
      },
    });
    const controller = createAdmissionController([]);
    await harness.run(controller);
    expect(controller.project).toHaveBeenCalledTimes(2);
    expect(harness.invoke).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("starts the original step timeout only after compaction admission", async () => {
    vi.useFakeTimers();
    const harness = createAdmissionFixture({ counts: [23814, 21000] });
    const active = createAdmissionStage("active_request", "active");
    const prepare = active.prepare.getMockImplementation()!;
    active.prepare.mockImplementation(async (messages) => {
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(30_000);
      return prepare(messages);
    });
    harness.invoke.mockImplementation(async () => {
      expect(vi.getTimerCount()).toBe(1);
      return { text: "ok", meta: {} };
    });
    await expect(
      harness.run(createAdmissionController([active])),
    ).resolves.toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each([
    ["session_history", "session_memory_compaction_timeout"],
    ["active_request", "context_compaction_timeout"],
  ] as const)(
    "reports a %s compactor timeout without regenerating or committing",
    async (scope, issueCode) => {
      const harness = createAdmissionFixture();
      const history = createAdmissionStage("session_history", "history");
      const active = createAdmissionStage("active_request", "active");
      const stage = scope === "session_history" ? history : active;
      const timeout = new ModelStepTimeoutError(issueCode, "context.compact");
      stage.prepare.mockRejectedValue(timeout);
      await expect(
        harness.run(createAdmissionController([history, active])),
      ).rejects.toBe(timeout);
      expect(history.prepare).toHaveBeenCalledOnce();
      expect(active.prepare).toHaveBeenCalledTimes(
        scope === "active_request" ? 1 : 0,
      );
      expect(history.commit).not.toHaveBeenCalled();
      expect(active.commit).not.toHaveBeenCalled();
      expect(harness.invoke).not.toHaveBeenCalled();
      expect(
        harness.events.filter(([name]) => name === "context.compaction.failed"),
      ).toEqual([
        [
          "context.compaction.failed",
          expect.objectContaining({
            reason: "context_compaction_timeout",
            issueCode,
          }),
        ],
      ]);
    },
  );

  test.each([
    { label: "an ordinary error", error: new Error("context_compaction_timeout") },
    {
      label: "another model step's timeout",
      error: new ModelStepTimeoutError(
        "context_compaction_timeout",
        "execution.decision",
      ),
    },
  ])("keeps $label outside compactor timeout classification", async ({ error }) => {
    const harness = createAdmissionFixture();
    const active = createAdmissionStage("active_request", "active");
    active.prepare.mockRejectedValue(error);
    await expect(
      harness.run(createAdmissionController([active])),
    ).rejects.toBe(error);
    expect(harness.events).toContainEqual([
      "context.compaction.failed",
      expect.objectContaining({
        reason: "semantic_checkpoint_rejected",
        issueCode: "context_compaction_timeout",
      }),
    ]);
    expect(active.commit).not.toHaveBeenCalled();
    expect(harness.invoke).not.toHaveBeenCalled();
  });

  test("keeps parent cancellation primary over a concurrent compactor timeout", async () => {
    const harness = createAdmissionFixture();
    const active = createAdmissionStage("active_request", "active");
    const cancellation = new Error("request_cancelled");
    active.prepare.mockImplementation(async () => {
      harness.abort.abort(cancellation);
      throw new ModelStepTimeoutError("context_compaction_timeout", "context.compact");
    });
    await expect(
      harness.run(createAdmissionController([active])),
    ).rejects.toBe(cancellation);
    expect(harness.events).toContainEqual([
      "context.compaction.failed",
      expect.objectContaining({
        reason: "request_aborted",
        issueCode: "request_cancelled",
      }),
    ]);
    expect(active.commit).not.toHaveBeenCalled();
    expect(harness.invoke).not.toHaveBeenCalled();
  });
});

function createSteeringFixture(boundary: Boundary, child = false) {
  const harness = createAdmissionFixture({
    modelStep: child ? "worker.decision" : "supervisor.decision",
  });
  const history = createAdmissionStage("session_history", "history");
  const active = createAdmissionStage("active_request", "active");
  let changed = false;
  const steer = () => {
    changed = true;
    harness.steering.append({ steerId: "one", text: "new direction" });
  };
  const count = harness.countInputTokens.getMockImplementation()!;
  harness.countInputTokens.mockImplementation(async (...args) => {
    const result = await count(...args);
    if (changed && !child) return { ...result!, inputTokens: 1000 };
    const target = { initial_count: 1, history_count: 2, active_count: 3 }[
      boundary as "initial_count" | "history_count" | "active_count"
    ];
    if (harness.countInputTokens.mock.calls.length === target) steer();
    return result;
  });
  if (boundary.endsWith("prepare")) {
    const stage = boundary === "history_prepare" ? history : active;
    const prepare = stage.prepare.getMockImplementation()!;
    stage.prepare.mockImplementation(async (messages) => {
      const value = await prepare(messages);
      steer();
      return value;
    });
  }
  if (boundary === "history_commit")
    history.commit.mockImplementation(async () => steer());
  if (boundary === "active_commit") active.commit.mockImplementation(steer);
  return {
    harness,
    history,
    active,
    controller: createAdmissionController([history, active]),
  };
}

function assertSupersededLifecycle(
  harness: ReturnType<typeof createAdmissionFixture>,
  boundary: Boundary,
) {
  const cycles = harness.events.filter(([name]) =>
    name.startsWith("context.compaction."),
  );
  if (boundary === "initial_count") {
    expect(cycles).toEqual([]);
    return;
  }
  expect(cycles).toEqual([
    ["context.compaction.started", expect.any(Object)],
    [
      "context.compaction.failed",
      expect.objectContaining({
        reason: "steering_superseded",
        issueCode: "model_step_steering_superseded",
      }),
    ],
  ]);
}
