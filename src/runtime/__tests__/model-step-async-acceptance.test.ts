import { describe, expect, test, vi } from "vitest";
import { ModelStepSteeringSupersededError } from "../model/model-step-steering.js";
import {
  ADMISSION_MESSAGES,
  createAdmissionFixture,
} from "./support/compaction-admission-fixture.js";

describe("asynchronous model output acceptance", () => {
  test("awaits acceptance and preserves a real validation failure", async () => {
    const harness = createAdmissionFixture({ counts: [1_000] });
    const failure = new Error("checkpoint_token_budget_exceeded");
    const accept = vi.fn(async () => {
      await Promise.resolve();
      throw failure;
    });
    await expect(
      harness.invoker.invoke({
        modelStep: "supervisor.decision",
        messages: ADMISSION_MESSAGES,
        timeoutReason: "test_timeout",
        accept,
      }),
    ).rejects.toBe(failure);
    expect(accept).toHaveBeenCalledOnce();
    expect(harness.invoke).toHaveBeenCalledOnce();
  });

  test("request cancellation during acceptance rejects an otherwise valid result", async () => {
    const harness = createAdmissionFixture({ counts: [1_000] });
    const failure = new Error("request_cancelled");
    await expect(
      harness.invoker.invoke({
        modelStep: "supervisor.decision",
        messages: ADMISSION_MESSAGES,
        timeoutReason: "test_timeout",
        async accept() {
          await Promise.resolve();
          harness.abort.abort(failure);
          return "stale";
        },
      }),
    ).rejects.toBe(failure);
    expect(harness.invoke).toHaveBeenCalledOnce();
  });

  test("bound output is rejected when steering changes during asynchronous acceptance", async () => {
    const harness = createAdmissionFixture({ counts: [1_000] });
    await expect(
      harness.invoker.invoke({
        modelStep: "supervisor.decision",
        messages: ADMISSION_MESSAGES,
        timeoutReason: "test_timeout",
        boundSteeringVersion: 0,
        async accept() {
          await Promise.resolve();
          harness.steering.append({
            steerId: "new",
            text: "updated user direction",
          });
          return "stale";
        },
      }),
    ).rejects.toBeInstanceOf(ModelStepSteeringSupersededError);
    expect(harness.invoke).toHaveBeenCalledOnce();
  });

  test("unbound root discards a superseded accepted result and returns the fresh attempt", async () => {
    const harness = createAdmissionFixture({ counts: [1_000, 1_000] });
    const accept = vi.fn(async () => {
      await Promise.resolve();
      if (accept.mock.calls.length === 1) {
        harness.steering.append({
          steerId: "new",
          text: "updated user direction",
        });
        return "stale";
      }
      return "fresh";
    });
    await expect(
      harness.invoker.invoke({
        modelStep: "supervisor.decision",
        messages: ADMISSION_MESSAGES,
        timeoutReason: "test_timeout",
        accept,
      }),
    ).resolves.toBe("fresh");
    expect(accept).toHaveBeenCalledTimes(2);
    expect(harness.invoke).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(harness.invoke.mock.calls[1]![0].messages)).toContain(
      "updated user direction",
    );
  });
});
