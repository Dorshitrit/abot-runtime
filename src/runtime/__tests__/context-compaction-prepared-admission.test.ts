import { describe, expect, test } from "vitest";
import type { ModelStepCompactionScope } from "../model/model-step-port.js";
import {
  ADMISSION_MESSAGES,
  createAdmissionController,
  createAdmissionFixture,
  createAdmissionStage,
} from "./support/compaction-admission-fixture.js";

function preparedStage(scope: ModelStepCompactionScope, exhausted?: boolean) {
  const stage = createAdmissionStage(scope, scope);
  const prepare = stage.prepare.getMockImplementation()!;
  stage.prepare.mockImplementation(async (messages) => {
    const outcome = await prepare(messages);
    if (outcome.kind !== "prepared") return outcome;
    return {
      ...outcome,
      preparation: {
        ...outcome.preparation,
        hasExhaustedCompactionSources: exhausted,
      },
    };
  });
  return stage;
}

describe.each([
  "execution.decision",
  "worker.decision",
  "tool_payload.raw",
] as const)("%s prepared compaction admission", (modelStep) => {
  test.each([22400, 23000, 26704])(
    "admits exhausted active evidence within budget at %s tokens",
    async (tokens) => {
      const h = createAdmissionFixture({ modelStep, counts: [28000, tokens] });
      const active = preparedStage("active_request", true);
      await expect(h.run(createAdmissionController([active]))).resolves.toBe(
        "ok",
      );
      expect(active.commit).toHaveBeenCalledOnce();
      expect(h.invoke.mock.calls[0]![0].messages).toEqual(
        h.countInputTokens.mock.calls[1]![0].messages,
      );
    },
  );

  test.each([false, undefined])(
    "rejects without exhaustion proof (%s)",
    async (proof) => {
      const h = createAdmissionFixture({ modelStep, counts: [28000, 23000] });
      const active = preparedStage("active_request", proof);
      await expect(h.run(createAdmissionController([active]))).rejects.toThrow(
        "context_compaction_projection_not_reduced",
      );
      expect(active.commit).not.toHaveBeenCalled();
      expect(h.invoke).not.toHaveBeenCalled();
    },
  );

  test.each([26705, 28000])(
    "rejects over-budget or unreduced candidate at %s",
    async (tokens) => {
      const h = createAdmissionFixture({ modelStep, counts: [28000, tokens] });
      const active = preparedStage("active_request", true);
      await expect(h.run(createAdmissionController([active]))).rejects.toThrow(
        "context_compaction_projection_not_reduced",
      );
      expect(active.commit).not.toHaveBeenCalled();
      expect(h.invoke).not.toHaveBeenCalled();
    },
  );

  test("requires both scopes to be retained and exhausted, then commits in order", async () => {
    const h = createAdmissionFixture({
      modelStep,
      counts: [28000, 24000, 23000],
    });
    const history = preparedStage("session_history", true);
    const active = preparedStage("active_request", true);
    const committed: string[] = [];
    history.commit.mockImplementation(() => {
      committed.push("history");
    });
    active.commit.mockImplementation(() => {
      committed.push("active");
    });
    await expect(
      h.run(createAdmissionController([history, active])),
    ).resolves.toBe("ok");
    expect(active.prepare.mock.calls[0]![0].at(-1)?.content).toBe(
      "session_history",
    );
    expect(committed).toEqual(["history", "active"]);
    expect(h.invoke.mock.calls[0]![0].messages).toEqual(
      h.countInputTokens.mock.calls[2]![0].messages,
    );
  });

  test.each([28000, 29000])(
    "cannot reuse discarded history proof at %s tokens",
    async (historyTokens) => {
      const h = createAdmissionFixture({
        modelStep,
        counts: [28000, historyTokens, 23000],
      });
      const history = preparedStage("session_history", true);
      const active = preparedStage("active_request", true);
      await expect(
        h.run(createAdmissionController([history, active])),
      ).rejects.toThrow("context_compaction_projection_not_reduced");
      expect(active.prepare).toHaveBeenCalledWith(ADMISSION_MESSAGES);
      expect(history.commit).not.toHaveBeenCalled();
      expect(active.commit).not.toHaveBeenCalled();
      expect(h.invoke).not.toHaveBeenCalled();
    },
  );

  test.each([false, undefined])(
    "cannot ignore retained but unexhausted history (%s)",
    async (proof) => {
      const h = createAdmissionFixture({
        modelStep,
        counts: [28000, 24000, 23000],
      });
      const history = preparedStage("session_history", proof);
      const active = preparedStage("active_request", true);
      await expect(
        h.run(createAdmissionController([history, active])),
      ).rejects.toThrow("context_compaction_projection_not_reduced");
      expect(history.commit).not.toHaveBeenCalled();
      expect(active.commit).not.toHaveBeenCalled();
      expect(h.invoke).not.toHaveBeenCalled();
    },
  );

  test("does not treat unavailable history as an exhaustion proof", async () => {
    const h = createAdmissionFixture({ modelStep, counts: [28000, 23000] });
    const history = preparedStage("session_history", true);
    history.prepare.mockResolvedValue({
      kind: "unavailable",
      reason: "no_new_sources",
    });
    const active = preparedStage("active_request", true);
    await expect(
      h.run(createAdmissionController([history, active])),
    ).rejects.toThrow("context_compaction_projection_not_reduced");
    expect(active.commit).not.toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();
  });
});

test.each(["reject", "cancel"] as const)(
  "cannot dispatch when exhausted history commit %s occurs",
  async (mode) => {
    const h = createAdmissionFixture({ counts: [28000, 24000, 23000] });
    const history = preparedStage("session_history", true);
    const active = preparedStage("active_request", true);
    const failure = new Error(
      mode === "cancel" ? "request_cancelled" : "history_persistence_failed",
    );
    history.commit.mockImplementation(async () => {
      if (mode === "cancel") {
        h.abort.abort(failure);
        return;
      }
      throw failure;
    });
    await expect(
      h.run(createAdmissionController([history, active])),
    ).rejects.toBe(failure);
    expect(active.commit).not.toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();
    expect(
      h.events.some(([name]) => name === "context.compaction.completed"),
    ).toBe(false);
  },
);
