import { describe, expect, test, vi } from "vitest";
import { stagedSuperFixture } from "./support/super-staged-compaction-fixture.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { ModelStepInvocationInput } from "../model/model-step-port.js";
import type { BoundRequestModelInvocationContext } from "../request/contracts.js";
import { resolveModelInvocation } from "../../model-gateway/invocation-policy.js";
import { createSemanticCompactionSha256Fingerprint } from "../context/semantic-compaction/contracts.js";
import { buildSuperCompactionStageMessages } from "../context/super-compaction/capsule.js";
import { doesSuperCompactionStageFit } from "../context/super-compaction/model-call.js";
import {
  mergeSuperCompactionWindows,
  type SuperCompactionWindowDraft,
} from "../context/super-compaction/window-merge.js";

type MergeCapsule = {
  kind: string;
  sourceAuthority: string;
  currentRequest: string;
  source: {
    sourceRef: string;
    sourceFingerprint: string;
    range: { startByte: number; endByteExclusive: number };
  };
  children: Array<{
    range: { startByte: number; endByteExclusive: number };
    digest: string;
  }>;
};

function fixture(count = 4, maxCharacters = 256, compactOutput = false, childOutputCharacters = 0) {
  const calls: Array<{
    input: ModelStepInvocationInput<unknown>;
    capsule: MergeCapsule;
  }> = [];
  const content = "x".repeat(count * 100);
  const source = {
    sourceRef: "bound-evidence",
    content,
    sourceFingerprint: createSemanticCompactionSha256Fingerprint(content),
  };
  const abort = new AbortController();
  const signal = abort.signal;
  const request = {
    ...stagedSuperFixture(false).request,
    abortSignal: signal,
    modelSteps: {
      async invoke<T>(input: ModelStepInvocationInput<T>): Promise<T> {
        const data = JSON.parse(input.messages[1]!.content);
        const capsule = (data.baseCapsule ?? data) as MergeCapsule;
        calls.push({ input, capsule });
        const joined = capsule.children
          .map((child) => child.digest)
          .join(" | ");
        let output = compactOutput
          ? (joined.match(/Distinct finding \d+\./g) ?? []).join(" ")
          : joined;
        if (capsule.source.range.endByteExclusive - capsule.source.range.startByte === 200)
          output = output.padEnd(childOutputCharacters, ".");
        return input.accept(output, { outputLength: output.length }, signal);
      },
    },
  } as unknown as BoundRequestModelInvocationContext;
  const drafts: SuperCompactionWindowDraft[] = Array.from(
    { length: count },
    (_, index) => ({
      range: {
        startByte: index * 100,
        endByteExclusive: (index + 1) * 100,
        totalBytes: content.length,
      },
      coverage: `Only range ${index} observed.`,
      content: `Distinct finding ${index}.`,
      baseMessages: Object.freeze([
        {
          role: "user",
          content: JSON.stringify({ kind: "window", index }),
        } as ChatMessage,
      ]),
    }),
  );
  const params = {
    request,
    source,
    currentRequest: "Preserve the observed facts.",
    assignment: { objective: "Continue bounded work" },
    maxCharacters,
    drafts,
  };
  return { params, calls, drafts, abort, countTokens: vi.mocked(request.modelGatewayClient.countInputTokens!) };
}

describe("SUPER independent-window merge", () => {
  test("combines adjacent pairs in balanced rounds with canonical ranges", async () => {
    const f = fixture();
    const result = await mergeSuperCompactionWindows(f.params);
    expect(f.calls).toHaveLength(3);
    expect(
      f.calls.map(({ capsule }) =>
        capsule.children.map(({ range }) => [
          range.startByte,
          range.endByteExclusive,
        ]),
      ),
    ).toEqual([
      [
        [0, 100],
        [100, 200],
      ],
      [
        [200, 300],
        [300, 400],
      ],
      [
        [0, 200],
        [200, 400],
      ],
    ]);
    for (const { input, capsule } of f.calls) {
      expect(input.modelStep).toBe("super.compact.merge");
      expect(input.contextRetention).toBe("exact");
      expect(capsule.kind).toBe("runtime_super_compaction_merge_v1");
      expect(capsule.source).toMatchObject({
        sourceRef: f.params.source.sourceRef,
        sourceFingerprint: f.params.source.sourceFingerprint,
      });
      expect(capsule.children).toHaveLength(2);
      expect(capsule.source).not.toHaveProperty("content");
    }
    for (let index = 0; index < 4; index += 1)
      expect(result.digest).toContain(`Distinct finding ${index}.`);
    const finalCall = f.calls.at(-1)!;
    const finalData = JSON.parse(finalCall.input.messages[1]!.content);
    expect(JSON.parse(result.baseMessages[0]!.content)).toEqual(
      finalData.baseCapsule ?? finalData,
    );
    expect(result.derived.content).toContain("Distinct finding 0.");
    expect(result.derived.content).toContain("Distinct finding 3.");
  });

  test("carries an odd final window forward without merging it into every earlier draft", async () => {
    const f = fixture(5);
    const result = await mergeSuperCompactionWindows({
      ...f.params,
      authority: "prior_conversation",
    });
    expect(f.calls).toHaveLength(4);
    expect(
      f.calls
        .at(-1)!
        .capsule.children.map(({ range }) => [
          range.startByte,
          range.endByteExclusive,
        ]),
    ).toEqual([
      [0, 400],
      [400, 500],
    ]);
    expect(
      f.calls.every(
        ({ capsule }) => capsule.sourceAuthority === "prior_conversation",
      ),
    ).toBe(true);
    expect(result.digest).toContain("Distinct finding 4.");
  });

  test("a single window reuses its exact base for final continuation without a merge call", async () => {
    const f = fixture(1);
    const result = await mergeSuperCompactionWindows(f.params);
    expect(f.calls).toHaveLength(0);
    expect(result.baseMessages).toBe(f.drafts[0]!.baseMessages);
    expect(result.derived).toEqual({
      coverage: f.drafts[0]!.coverage,
      content: f.drafts[0]!.content,
    });
  });

  test("rejects a hole in canonical coverage before invoking the merge model", async () => {
    const f = fixture();
    await expect(
      mergeSuperCompactionWindows({
        ...f.params,
        drafts: f.drafts.filter((_, index) => index !== 1),
      }),
    ).rejects.toThrow("super_compaction_window_coverage_invalid");
    expect(f.calls).toHaveLength(0);
  });
});


describe("SUPER lossless merge retention", () => {
  test.each(["base", "base-and-derived"] as const)("reduces deferred children for a smaller continuation budget (%s overflow)", async (edge) => {
    const tokens = (messages: readonly ChatMessage[]) => Math.ceil(Buffer.byteLength(JSON.stringify(messages)) / 4);
    const control = fixture(4, 256, true, 100);
    const count = async (input: Parameters<NonNullable<typeof control.params.request.modelGatewayClient.countInputTokens>>[0]) => {
      const invocation = resolveModelInvocation(input);
      return { inputTokens: tokens(input.messages as readonly ChatMessage[]),
        profileId: invocation.profile.id, provider: invocation.profile.provider, model: invocation.model,
        contextWindowTokens: invocation.profile.contextWindowTokens, source: "provider_input_token_count" as const };
    };
    control.countTokens.mockImplementation(count);
    const unchanged = await mergeSuperCompactionWindows({
      ...control.params, allowIntermediateJoins: true, continuationMaxCharacters: 1000,
    });
    expect(control.calls).toHaveLength(1);
    expect(control.calls[0]!.capsule.source.range).toMatchObject({ startByte: 0, endByteExclusive: 400 });
    const childCounts = control.countTokens.mock.calls.filter(([input]) => {
      const { baseCapsule } = JSON.parse((input.messages as readonly ChatMessage[])[1]!.content);
      return input.modelStep === "super.compact.continuation" &&
        baseCapsule.source.range.endByteExclusive - baseCapsule.source.range.startByte === 200;
    }).map(([input]) => tokens(input.messages as readonly ChatMessage[]));
    const parentBaseTokens = tokens(buildSuperCompactionStageMessages({
      stage: "continuation", baseMessages: unchanged.baseMessages, maxCharacters: 1000,
    }));
    const availableInputTokens = edge === "base" ? Math.max(...childCounts) + 1 : parentBaseTokens;
    expect(Math.max(...childCounts)).toBeLessThan(availableInputTokens);
    if (edge === "base") expect(parentBaseTokens).toBeGreaterThan(availableInputTokens);

    const f = fixture(4, 256, true, 100);
    f.countTokens.mockImplementation(count);
    const policy = f.params.request.modelPolicy!;
    const request = { ...f.params.request, modelPolicy: {
      ...policy, profiles: { ...policy.profiles,
        "narrow-continuation": { provider: "test", model: "narrow-continuation",
          contextWindowTokens: availableInputTokens + 2048 + 512 },
      },
      defaults: { ...policy.defaults, steps: { ...policy.defaults?.steps,
        "super.compact.continuation": "narrow-continuation",
      } },
    } };
    const result = await mergeSuperCompactionWindows({
      ...f.params, request,
      allowIntermediateJoins: true,
      continuationMaxCharacters: 1000,
    });
    const finalInput = { request, stage: "continuation" as const,
      baseMessages: result.baseMessages, derived: result.derived, maxCharacters: 1000 };
    expect(await doesSuperCompactionStageFit(finalInput)).toBe(true);
    expect(tokens(buildSuperCompactionStageMessages(finalInput))).toBeLessThanOrEqual(availableInputTokens);
    expect(f.calls.some(({ capsule }) => capsule.source.range.endByteExclusive - capsule.source.range.startByte === 200)).toBe(true);
    const base = JSON.parse(result.baseMessages[0]!.content) as MergeCapsule;
    const parentCalls = f.calls.filter(({ capsule }) => capsule.source.range.endByteExclusive - capsule.source.range.startByte === 400);
    expect(parentCalls).toHaveLength(1);
    expect(parentCalls[0]!.capsule).toEqual(base);
    expect(f.calls.length).toBeLessThanOrEqual(3);
    expect(new Set(f.calls.map(({ capsule }) => JSON.stringify(capsule.source.range))).size).toBe(f.calls.length);
    for (const [input] of f.countTokens.mock.calls) {
      const measuredBase = JSON.parse((input.messages as readonly ChatMessage[])[1]!.content).baseCapsule as MergeCapsule;
      expect(measuredBase.children.every(({ digest }) => digest.includes("Distinct finding"))).toBe(true);
    }
    expect(base.children.map(({ range }) => [range.startByte, range.endByteExclusive]))
      .toEqual([[0, 200], [200, 400]]);
    for (const draft of f.drafts) expect(result.digest).toContain(draft.content);
  });

  test("allows one compact parent after both reduced children still overflow the joined continuation", async () => {
    const f = fixture(4, 256, true, 200);
    const tokens = (messages: readonly ChatMessage[]) => Math.ceil(Buffer.byteLength(JSON.stringify(messages)) / 4);
    f.countTokens.mockImplementation(async (input) => {
      const invocation = resolveModelInvocation(input);
      return { inputTokens: tokens(input.messages as readonly ChatMessage[]),
        profileId: invocation.profile.id, provider: invocation.profile.provider, model: invocation.model,
        contextWindowTokens: invocation.profile.contextWindowTokens, source: "provider_input_token_count" };
    });
    const policy = f.params.request.modelPolicy!;
    const request = { ...f.params.request, modelPolicy: {
      ...policy, profiles: { ...policy.profiles,
        "narrow-continuation": { provider: "test", model: "narrow-continuation", contextWindowTokens: 3560 },
      },
      defaults: { ...policy.defaults, steps: { ...policy.defaults?.steps,
        "super.compact.continuation": "narrow-continuation",
      } },
    } };
    const result = await mergeSuperCompactionWindows({
      ...f.params, request, allowIntermediateJoins: true, continuationMaxCharacters: 1000,
    });
    expect(f.calls.map(({ capsule }) => [capsule.source.range.startByte, capsule.source.range.endByteExclusive]))
      .toEqual([[0, 200], [200, 400], [0, 400]]);
    const base = JSON.parse(result.baseMessages[0]!.content) as MergeCapsule;
    expect(base).toEqual(f.calls[2]!.capsule);
    expect(base.children.map(({ digest }) => digest.length)).toEqual([200, 200]);
    const finalInput = { request, stage: "continuation" as const,
      baseMessages: result.baseMessages, derived: result.derived, maxCharacters: 1000 };
    expect(await doesSuperCompactionStageFit(finalInput)).toBe(true);
    expect(tokens(buildSuperCompactionStageMessages(finalInput))).toBeLessThanOrEqual(1000);
    // Even bare concatenation exceeds the continuation budget; a final semantic
    // reduction is still useful after the deferred children have been reduced.
    const unreducedParent = { ...finalInput,
      derived: { content: base.children.map(({ digest }) => digest).join("\n") } };
    expect(tokens(buildSuperCompactionStageMessages(unreducedParent))).toBeGreaterThan(1000);
    for (const draft of f.drafts) expect(result.digest).toContain(draft.content);
  });

  test("reduces a deferred child once when its next parent exceeds merge input", async () => {
    const f = fixture(4, 256, true);
    const count = f.countTokens.getMockImplementation()!;
    f.countTokens.mockImplementation(async (input) => {
      const envelope = JSON.parse((input.messages as readonly ChatMessage[])[1]!.content);
      const children = envelope.baseCapsule.children as MergeCapsule["children"];
      const length = children.reduce((sum, child) => sum + child.digest.length, 0);
      return { ...(await count(input))!,
        inputTokens: input.modelStep === "super.compact.merge" && length > 500 ? 32000 : 1000 };
    });
    const result = await mergeSuperCompactionWindows({
      ...f.params, allowIntermediateJoins: true, continuationMaxCharacters: 1000,
    });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]!.capsule.source.range).toMatchObject({ startByte: 0, endByteExclusive: 200 });
    expect(f.calls[1]!.capsule.source.range).toMatchObject({ startByte: 0, endByteExclusive: 400 });
    for (const draft of f.drafts) expect(result.digest).toContain(draft.content);
    const parent = JSON.parse(result.baseMessages[0]!.content) as MergeCapsule;
    expect(parent.children.map(({ range }) => [range.startByte, range.endByteExclusive]))
      .toEqual([[0, 200], [200, 400]]);
  });

  test("does not repeatedly reduce model-authored children when their parent still cannot fit", async () => {
    const f = fixture(4, 256);
    const count = f.countTokens.getMockImplementation()!;
    f.countTokens.mockImplementation(async (input) => {
      const envelope = JSON.parse((input.messages as readonly ChatMessage[])[1]!.content);
      const range = envelope.baseCapsule.source.range;
      return { ...(await count(input))!, inputTokens:
        input.modelStep === "super.compact.merge" && range.endByteExclusive - range.startByte === 400
          ? 32000 : 1000 };
    });
    await expect(mergeSuperCompactionWindows({ ...f.params, allowIntermediateJoins: true }))
      .rejects.toThrow("super_compaction_input_exceeds_budget");
    expect(f.calls).toHaveLength(2);
    expect(f.calls.map(({ capsule }) => capsule.source.range.endByteExclusive - capsule.source.range.startByte))
      .toEqual([200, 200]);
  });

  test("joins over-target intermediate drafts but still asks the model to reduce the final source", async () => {
    const f = fixture(5, 256);
    const result = await mergeSuperCompactionWindows({
      ...f.params, allowIntermediateJoins: true, continuationMaxCharacters: 1000,
    });
    // A model output may exceed its writing target; final checkpoint admission still owns that check.
    expect(result.digest.length).toBeGreaterThan(f.params.maxCharacters);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.capsule.source.range).toMatchObject({ startByte: 0, endByteExclusive: 500 });
    let position = -1;
    for (const draft of f.drafts) {
      const next = result.digest.indexOf(draft.content);
      expect(next).toBeGreaterThan(position);
      expect(result.digest).toContain(draft.coverage);
      position = next;
    }
    expect(f.countTokens.mock.calls.some(([input]) => input.modelStep === "super.compact.continuation")).toBe(true);
  });

  test("does not bypass the original final-source limit for a two-window join", async () => {
    const f = fixture(2, 256);
    const baseline = fixture(2, 256);
    const result = await mergeSuperCompactionWindows({ ...f.params, allowIntermediateJoins: true });
    expect(result).toEqual(await mergeSuperCompactionWindows(baseline.params));
    expect(f.calls).toHaveLength(1);
    expect(f.calls.map(({ capsule }) => capsule)).toEqual(baseline.calls.map(({ capsule }) => capsule));
  });

  test("intermediate joins do not bypass continuation input admission", async () => {
    const f = fixture(4, 256);
    const count = f.countTokens.getMockImplementation()!;
    f.countTokens.mockImplementation(async (input) => ({ ...(await count(input))!,
      inputTokens: input.modelStep === "super.compact.continuation" ? 32000 : 1000 }));
    await mergeSuperCompactionWindows({
      ...f.params, allowIntermediateJoins: true, continuationMaxCharacters: 1000,
    });
    expect(f.calls).toHaveLength(3);
  });

  test.each(["settled_evidence", "prior_conversation"] as const)("retains all ordered derived evidence without a model call (%s)", async (authority) => {
    const f = fixture(5, 2400);
    f.drafts[0] = { ...f.drafts[0]!, content: "Status=failed; ID=אבג-42; 🔍; partial coverage only." };
    f.drafts[4] = { ...f.drafts[4]!, content: "Status=ready; ID=אבג-42; contradiction unresolved." };
    const before = structuredClone(f.drafts);
    const result = await mergeSuperCompactionWindows({ ...f.params, authority });
    expect(f.calls).toHaveLength(0);
    expect(result.digest.length).toBeLessThanOrEqual(f.params.maxCharacters);
    let position = -1;
    for (const draft of f.drafts) {
      expect(result.digest).toContain(draft.coverage);
      const next = result.digest.indexOf(draft.content);
      expect(next).toBeGreaterThan(position);
      position = next;
    }
    expect(f.drafts).toEqual(before);
    const base = JSON.parse(result.baseMessages[0]!.content);
    expect(base).toMatchObject({ sourceAuthority: authority,
      source: { sourceRef: f.params.source.sourceRef, sourceFingerprint: f.params.source.sourceFingerprint,
        range: { startByte: 0, endByteExclusive: 500, totalBytes: 500 } } });
    expect(base.source).not.toHaveProperty("content");
    expect(result.derived.content).toContain(f.drafts[4]!.content);
  });

  test("joins fitting pairs and asks the model only to reduce their oversized parent", async () => {
    const f = fixture(4, 500);
    const result = await mergeSuperCompactionWindows(f.params);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.capsule.children.map(({ range }) => [range.startByte, range.endByteExclusive]))
      .toEqual([[0, 200], [200, 400]]);
    for (const draft of f.drafts) expect(result.digest).toContain(draft.content);
  });

  test("counts source/range wrappers in the retained character budget", async () => {
    const fitting = fixture(2, 1000);
    const joined = await mergeSuperCompactionWindows(fitting.params);
    expect(fitting.calls).toHaveLength(0);
    const constrained = fixture(2, joined.digest.length - 1);
    await mergeSuperCompactionWindows(constrained.params);
    expect(constrained.calls).toHaveLength(1);
    expect(constrained.countTokens).not.toHaveBeenCalled();
  });

  test("uses the model when the actual merge envelope exceeds input admission", async () => {
    const f = fixture(2, 1000);
    const count = f.countTokens.getMockImplementation()!;
    f.countTokens.mockImplementation(async (input) => ({ ...(await count(input))!, inputTokens: 32000 }));
    await mergeSuperCompactionWindows(f.params);
    expect(f.calls).toHaveLength(1);
    expect(f.countTokens.mock.calls[0]![0].modelStep).toBe("super.compact.merge");
  });

  test("admits the exact continuation envelope with both children and the retained text", async () => {
    const f = fixture(2, 1000);
    const result = await mergeSuperCompactionWindows({ ...f.params, continuationMaxCharacters: 1000 });
    expect(f.calls).toHaveLength(0);
    const input = f.countTokens.mock.calls.find(([input]) => input.modelStep === "super.compact.continuation")![0];
    const messages = input.messages as readonly ChatMessage[];
    expect(messages.map(({ role }) => role)).toEqual(["system", "user"]);
    const envelope = JSON.parse(messages[1]!.content);
    expect(envelope.baseCapsule).toEqual(JSON.parse(result.baseMessages[0]!.content));
    expect(envelope.baseCapsule.currentRequest).toBe(f.params.currentRequest);
    expect(envelope.derivedStageOutputs.outputs).toEqual(result.derived);
    expect(envelope.baseCapsule.children).toHaveLength(2);
  });

  test("reduces with the model when retained text would overflow continuation input", async () => {
    const f = fixture(2, 1000);
    const count = f.countTokens.getMockImplementation()!;
    f.countTokens.mockImplementation(async (input) => ({ ...(await count(input))!,
      inputTokens: input.modelStep === "super.compact.continuation" ? 32000 : 1000 }));
    await mergeSuperCompactionWindows({ ...f.params, continuationMaxCharacters: 1000 });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.input.modelStep).toBe("super.compact.merge");
  });

  test("uses the existing complete-envelope estimate when provider counting is unavailable", async () => {
    const f = fixture(2, 1000);
    f.countTokens.mockResolvedValue(undefined);
    const result = await mergeSuperCompactionWindows({ ...f.params, continuationMaxCharacters: 1000 });
    expect(f.calls).toHaveLength(0);
    for (const draft of f.drafts) expect(result.digest).toContain(draft.content);
  });

  test("cancellation during admission cannot accept a joined draft or call the model", async () => {
    const f = fixture(2, 1000);
    const count = f.countTokens.getMockImplementation()!;
    f.countTokens.mockImplementation(async (input) => {
      const result = await count(input);
      f.abort.abort(new Error("cancelled-during-merge-admission"));
      return result;
    });
    await expect(mergeSuperCompactionWindows(f.params)).rejects.toThrow("cancelled-during-merge-admission");
    expect(f.calls).toHaveLength(0);
  });
});
