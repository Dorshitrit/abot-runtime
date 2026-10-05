import { afterEach, expect, test, vi } from "vitest";
import { ModelStepTimeoutError } from "../steps/model-step-timeout.js";
import { ADMISSION_MESSAGES, createAdmissionFixture } from "./support/compaction-admission-fixture.js";

afterEach(() => vi.useRealTimers());

test.each(["timeout", "request_cancelled"] as const)(
  "stalled acceptance settles on %s and consumes a late rejection",
  async (cause) => {
    vi.useFakeTimers();
    const harness = createAdmissionFixture({ counts: [1_000] });
    let acceptanceSignal: AbortSignal | undefined;
    let rejectAcceptance!: (error: Error) => void;
    const result = harness.invoker.invoke({
      modelStep: "supervisor.decision",
      messages: ADMISSION_MESSAGES,
      timeoutReason: "acceptance_timeout",
      accept(_text, _diagnostics, signal) {
        acceptanceSignal = signal;
        return new Promise<string>((_resolve, reject) => {
          rejectAcceptance = reject;
        });
      },
    });
    const cancellation = new Error("request_cancelled");
    const expected = cause === "timeout"
      ? expect(result).rejects.toMatchObject({
          name: "ModelStepTimeoutError", code: "acceptance_timeout",
        })
      : expect(result).rejects.toBe(cancellation);
    await vi.advanceTimersByTimeAsync(0);
    expect(acceptanceSignal).toBe(harness.invoke.mock.calls[0]![0].abortSignal);
    expect(acceptanceSignal).not.toBe(harness.abort.signal);
    if (cause === "timeout") await vi.advanceTimersByTimeAsync(20_000);
    else harness.abort.abort(cancellation);
    await expected;
    expect(acceptanceSignal?.aborted).toBe(true);
    expect(harness.abort.signal.aborted).toBe(cause === "request_cancelled");
    rejectAcceptance(new Error("late_validation_failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.invoke).toHaveBeenCalledOnce();
    if (cause === "timeout")
      expect(acceptanceSignal?.reason).toBeInstanceOf(ModelStepTimeoutError);
  },
);

test("ordinary async acceptance uses the provider attempt signal and disposes its deadline", async () => {
  vi.useFakeTimers();
  const harness = createAdmissionFixture({ counts: [1_000] });
  let acceptanceSignal: AbortSignal | undefined;
  const result = harness.invoker.invoke({
    modelStep: "supervisor.decision",
    messages: ADMISSION_MESSAGES,
    timeoutReason: "acceptance_timeout",
    async accept(text, _diagnostics, signal) {
      acceptanceSignal = signal;
      await Promise.resolve();
      return text + ":accepted";
    },
  });
  await expect(result).resolves.toBe("ok:accepted");
  expect(acceptanceSignal).toBe(harness.invoke.mock.calls[0]![0].abortSignal);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(acceptanceSignal?.aborted).toBe(false);
});
