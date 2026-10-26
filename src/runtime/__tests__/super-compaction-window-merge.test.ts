import { describe, expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { ModelStepInvocationInput } from "../model/model-step-port.js";
import type { BoundRequestModelInvocationContext } from "../request/contracts.js";
import { createSemanticCompactionSha256Fingerprint } from "../context/semantic-compaction/contracts.js";
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

function fixture(count = 4) {
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
  const signal = new AbortController().signal;
  const request = {
    abortSignal: signal,
    modelSteps: {
      async invoke<T>(input: ModelStepInvocationInput<T>): Promise<T> {
        const data = JSON.parse(input.messages[1]!.content);
        const capsule = (data.baseCapsule ?? data) as MergeCapsule;
        calls.push({ input, capsule });
        const output = capsule.children
          .map((child) => child.digest)
          .join(" | ");
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
    maxCharacters: 500,
    drafts,
  };
  return { params, calls, drafts };
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
