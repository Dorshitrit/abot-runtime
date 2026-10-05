import { afterEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { generateSemanticCompactionCandidateBatched } from "../context/semantic-compaction/run.js";
import { readCompactionEnvelope, semanticContractFixture } from "./support/semantic-compaction-contract-fixture.js";

afterEach(() => vi.useRealTimers());

test.each([
  ["execution-agent-v1", false],
  ["execution-agent-v1", true],
  ["supervisor-worker-v1", false],
  ["supervisor-worker-v1", true],
] as const)(
  "%s cancels checkpoint counting with the actual compaction attempt signal (sliced=%s)",
  async (policy, sliced) => {
    vi.useFakeTimers();
    const fixture = semanticContractFixture({ policy, sliced });
    const normalCount = fixture.countInputTokens.getMockImplementation()!;
    let countingSignal: AbortSignal | undefined;
    const countingAborted = vi.fn();
    fixture.countInputTokens.mockImplementation((input) => {
      if (readCompactionEnvelope(input.messages as readonly ChatMessage[]).kind !== "runtime_semantic_compaction_checkpoint_v2")
        return normalCount(input);
      countingSignal = input.abortSignal;
      return new Promise((_resolve, reject) => {
        input.abortSignal.addEventListener("abort", () => {
          countingAborted();
          reject(input.abortSignal.reason);
        }, { once: true });
      });
    });
    const result = generateSemanticCompactionCandidateBatched(fixture.params);
    const expected = expect(result).rejects.toMatchObject({
      name: "ModelStepTimeoutError",
      code: "context_compaction_timeout",
      modelStep: "context.compact",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.invoke).toHaveBeenCalledOnce();
    expect(countingSignal).toBe(fixture.invoke.mock.calls[0]![0].abortSignal);
    expect(countingSignal).not.toBe(fixture.params.request.abortSignal);
    expect(readCompactionEnvelope(fixture.captured[0]!).sourceSlice !== undefined).toBe(sliced);
    await vi.advanceTimersByTimeAsync(20_000);
    await expected;
    expect(countingAborted).toHaveBeenCalledOnce();
    expect(countingSignal?.aborted).toBe(true);
    expect(fixture.params.request.abortSignal.aborted).toBe(false);
    expect(fixture.store.get(fixture.params.scopeId)).toBeUndefined();
    expect(fixture.invoke).toHaveBeenCalledOnce();
  },
);
