import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { ModelStepCompactionStage } from "../model/model-step-port.js";
import { ModelStepSteeringSupersededError } from "../model/model-step-steering.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import {
  ADMISSION_MESSAGES,
  createAdmissionController,
  createAdmissionFixture,
  createAdmissionStage,
} from "./support/compaction-admission-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

const history: ChatMessage = {
  role: "assistant",
  content: "Exact previous conversation remains available.",
};
const optionalReference: ChatMessage = {
  role: "system",
  content: "Optional request-local reference.",
};
const mandatory = [ADMISSION_MESSAGES[0]!, history, ADMISSION_MESSAGES[1]!];
const withOptional = [
  ...mandatory.slice(0, -1),
  optionalReference,
  mandatory.at(-1)!,
];

function optionalController(stages: readonly ModelStepCompactionStage[]) {
  const controller = createAdmissionController(stages);
  controller.project.mockImplementation(() => [...withOptional]);
  const projectForCompaction = vi.fn<
    (messages: readonly ChatMessage[]) => readonly ChatMessage[]
  >((messages) => messages.filter((message) => message !== optionalReference));
  return { ...controller, projectForCompaction };
}

function compactionEvents(harness: ReturnType<typeof createAdmissionFixture>) {
  return harness.events.filter(([name]) =>
    name.startsWith("context.compaction."),
  );
}

describe("optional projection before measured context compaction", () => {
  test.each(["empty plan", "no eligible sources"] as const)(
    "admits the exact remaining context without preparing %s",
    async (plan) => {
      const harness = createAdmissionFixture({ counts: [23_814, 21_000] });
      const active = createAdmissionStage("active_request", "active");
      active.prepare.mockResolvedValue({
        kind: "unavailable",
        reason: "no_eligible_sources",
      });
      const controller = optionalController(
        plan === "empty plan" ? [] : [active],
      );

      await expect(harness.run(controller)).resolves.toBe("ok");

      expect(controller.projectForCompaction).toHaveBeenCalledExactlyOnceWith(
        withOptional,
      );
      expect(harness.countInputTokens).toHaveBeenCalledTimes(2);
      expect(harness.countInputTokens.mock.calls[0]![0].messages).toEqual(
        withOptional,
      );
      expect(harness.countInputTokens.mock.calls[1]![0].messages).toEqual(
        mandatory,
      );
      expect(harness.invoke).toHaveBeenCalledOnce();
      expect(harness.invoke.mock.calls[0]![0].messages).toEqual(mandatory);
      expect(active.prepare).not.toHaveBeenCalled();
      expect(active.commit).not.toHaveBeenCalled();
      expect(compactionEvents(harness)).toEqual([]);
    },
  );

  test("reuses trusted exhausted evidence after optional removal while still above the trigger", async () => {
    const harness = createAdmissionFixture({ counts: [23_814, 23_000] });
    const active = createAdmissionStage("active_request", "active");
    const controller = optionalController([active]);
    const hasExhaustedVerifiedCompactionSources = vi.fn(
      (_messages: readonly ChatMessage[]) => true,
    );

    await expect(
      harness.run({ ...controller, hasExhaustedVerifiedCompactionSources }),
    ).resolves.toBe("ok");

    expect(controller.projectForCompaction).toHaveBeenCalledOnce();
    const stripped = controller.projectForCompaction.mock.results[0]!.value;
    expect(
      hasExhaustedVerifiedCompactionSources,
    ).toHaveBeenCalledExactlyOnceWith(stripped);
    expect(hasExhaustedVerifiedCompactionSources.mock.calls[0]![0]).toBe(
      stripped,
    );
    expect(stripped).toEqual(mandatory);
    expect(harness.countInputTokens).toHaveBeenCalledTimes(2);
    expect(harness.invoke).toHaveBeenCalledOnce();
    expect(harness.invoke.mock.calls[0]![0].messages).toEqual(mandatory);
    expect(active.prepare).not.toHaveBeenCalled();
    expect(active.commit).not.toHaveBeenCalled();
    expect(compactionEvents(harness)).toEqual([]);
  });

  test("preserves the history-then-active chain when removal alone does not fit", async () => {
    const harness = createAdmissionFixture({
      counts: [25_000, 24_000, 23_000, 21_000],
    });
    const commits: string[] = [];
    const historyStage = createAdmissionStage(
      "session_history",
      "history-checkpoint",
    );
    const active = createAdmissionStage("active_request", "active-checkpoint");
    historyStage.commit.mockImplementation(() => {
      commits.push("history");
    });
    active.commit.mockImplementation(() => {
      commits.push("active");
    });
    const controller = optionalController([historyStage, active]);

    await expect(harness.run(controller)).resolves.toBe("ok");

    expect(controller.projectForCompaction).toHaveBeenCalledOnce();
    expect(historyStage.prepare).toHaveBeenCalledExactlyOnceWith(mandatory, { onProgress: expect.any(Function) });
    expect(active.prepare).toHaveBeenCalledExactlyOnceWith(
      [...mandatory, { role: "system", content: "history-checkpoint" }],
      { onProgress: expect.any(Function) },
    );
    expect(commits).toEqual(["history", "active"]);
    expect(harness.countInputTokens).toHaveBeenCalledTimes(4);
    expect(harness.invoke).toHaveBeenCalledOnce();
    expect(harness.invoke.mock.calls[0]![0].messages).toEqual(
      harness.countInputTokens.mock.calls[3]![0].messages,
    );
    expect(compactionEvents(harness).map(([name]) => name)).toEqual([
      "context.compaction.started",
      "context.compaction.completed",
    ]);
  });

  test.each(["absent", "same identity"] as const)(
    "%s hook does not add a token count or change existing stages",
    async (kind) => {
      const harness = createAdmissionFixture({ counts: [23_814, 21_000] });
      const active = createAdmissionStage("active_request", "active");
      const controller = optionalController([active]);
      controller.projectForCompaction.mockImplementation(
        (messages) => messages,
      );
      const existing = createAdmissionController([active]);
      const selected = kind === "absent" ? existing : controller;

      await harness.run(selected);

      expect(harness.countInputTokens).toHaveBeenCalledTimes(2);
      expect(controller.projectForCompaction).toHaveBeenCalledTimes(
        kind === "absent" ? 0 : 1,
      );
      expect(active.prepare).toHaveBeenCalledExactlyOnceWith(
        kind === "absent" ? ADMISSION_MESSAGES : withOptional,
        { onProgress: expect.any(Function) },
      );
      expect(active.commit).toHaveBeenCalledOnce();
      expect(harness.invoke).toHaveBeenCalledOnce();
    },
  );

  test("does not call the optional hook when the measured original already fits", async () => {
    const harness = createAdmissionFixture({ counts: [21_000] });
    const active = createAdmissionStage("active_request", "active");
    const controller = optionalController([active]);
    await harness.run(controller);
    expect(controller.projectForCompaction).not.toHaveBeenCalled();
    expect(harness.countInputTokens).toHaveBeenCalledOnce();
    expect(harness.invoke.mock.calls[0]![0].messages).toEqual(withOptional);
    expect(active.prepare).not.toHaveBeenCalled();
    expect(compactionEvents(harness)).toEqual([]);
  });

  test.each([22_400, 23_814, 25_000])(
    "continues once into semantic compaction when the optional recount is %s",
    async (recount) => {
      const harness = createAdmissionFixture({
        counts: [23_814, recount, 21_000],
      });
      const active = createAdmissionStage("active_request", "active");
      const controller = optionalController([active]);
      await expect(harness.run(controller)).resolves.toBe("ok");
      expect(controller.projectForCompaction).toHaveBeenCalledOnce();
      expect(active.prepare).toHaveBeenCalledExactlyOnceWith(mandatory, { onProgress: expect.any(Function) });
      expect(active.commit).toHaveBeenCalledOnce();
      expect(harness.countInputTokens).toHaveBeenCalledTimes(3);
      expect(harness.invoke).toHaveBeenCalledOnce();
    },
  );

  test("keeps existing exhaustion when optional removal is still over budget and no sources exist", async () => {
    const harness = createAdmissionFixture({ counts: [23_814, 23_000] });
    const active = createAdmissionStage("active_request", "active");
    active.prepare.mockResolvedValue({
      kind: "unavailable",
      reason: "no_eligible_sources",
    });
    const controller = optionalController([active]);
    await expect(harness.run(controller)).rejects.toThrow(
      "context_compaction_sources_empty",
    );
    expect(controller.projectForCompaction).toHaveBeenCalledOnce();
    expect(harness.countInputTokens).toHaveBeenCalledTimes(2);
    expect(active.prepare).toHaveBeenCalledExactlyOnceWith(mandatory, { onProgress: expect.any(Function) });
    expect(active.commit).not.toHaveBeenCalled();
    expect(harness.invoke).not.toHaveBeenCalled();
  });

  test.each(["count failure", "binding mismatch"] as const)(
    "propagates optional recount %s before any checkpoint or dispatch",
    async (failure) => {
      const harness = createAdmissionFixture({ counts: [23_814, 21_000] });
      const active = createAdmissionStage("active_request", "active");
      const controller = optionalController([active]);
      const count = harness.countInputTokens.getMockImplementation()!;
      harness.countInputTokens.mockImplementation(async (...args) => {
        const result = await count(...args);
        if (harness.countInputTokens.mock.calls.length === 1) return result;
        if (failure === "count failure")
          throw new Error("optional_count_failed");
        return { ...result!, model: "different-model" };
      });

      await expect(harness.run(controller)).rejects.toThrow(
        failure === "count failure"
          ? "optional_count_failed"
          : "model_input_token_count_binding_mismatch",
      );

      expect(controller.projectForCompaction).toHaveBeenCalledOnce();
      expect(harness.countInputTokens).toHaveBeenCalledTimes(2);
      expect(active.prepare).not.toHaveBeenCalled();
      expect(active.commit).not.toHaveBeenCalled();
      expect(harness.invoke).not.toHaveBeenCalled();
      expect(compactionEvents(harness)).toEqual([]);
    },
  );

  test("preserves cancellation that arrives during optional recount", async () => {
    const harness = createAdmissionFixture({ counts: [23_814, 21_000] });
    const active = createAdmissionStage("active_request", "active");
    const controller = optionalController([active]);
    const count = harness.countInputTokens.getMockImplementation()!;
    const cancelled = new Error("request_cancelled_during_optional_count");
    harness.countInputTokens.mockImplementation(async (...args) => {
      const result = await count(...args);
      if (harness.countInputTokens.mock.calls.length === 2)
        harness.abort.abort(cancelled);
      return result;
    });
    await expect(harness.run(controller)).rejects.toBe(cancelled);
    expect(active.prepare).not.toHaveBeenCalled();
    expect(active.commit).not.toHaveBeenCalled();
    expect(harness.invoke).not.toHaveBeenCalled();
    expect(compactionEvents(harness)).toEqual([]);
  });

  test.each([true, false])(
    "honors steering during optional recount with bound=%s",
    async (bound) => {
      const harness = createAdmissionFixture({
        counts: [23_814, 21_000, 1_000],
      });
      const active = createAdmissionStage("active_request", "active");
      const controller = optionalController([active]);
      const count = harness.countInputTokens.getMockImplementation()!;
      harness.countInputTokens.mockImplementation(async (...args) => {
        const result = await count(...args);
        if (harness.countInputTokens.mock.calls.length === 2)
          harness.steering.append({
            steerId: "new-direction",
            text: "Fresh user direction.",
          });
        return result;
      });
      const outcome = harness.run(controller, bound ? 0 : undefined);
      if (bound) {
        await expect(outcome).rejects.toBeInstanceOf(
          ModelStepSteeringSupersededError,
        );
        expect(harness.invoke).not.toHaveBeenCalled();
        expect(controller.project).toHaveBeenCalledOnce();
      } else {
        await expect(outcome).resolves.toBe("ok");
        expect(controller.project).toHaveBeenCalledTimes(2);
        expect(harness.invoke).toHaveBeenCalledOnce();
        expect(
          JSON.stringify(harness.invoke.mock.calls[0]![0].messages),
        ).toContain("Fresh user direction.");
      }
      expect(controller.projectForCompaction).toHaveBeenCalledOnce();
      expect(active.prepare).not.toHaveBeenCalled();
      expect(active.commit).not.toHaveBeenCalled();
      expect(compactionEvents(harness)).toEqual([]);
    },
  );
});
