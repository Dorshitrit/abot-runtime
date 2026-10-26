import { describe, expect, test } from "vitest";
import { MODEL_STEPS } from "../../shared/model-steps.js";
import type {
  ModelStepInvocationInput,
  ModelStepOutputDiagnostics,
} from "../model/model-step-port.js";
import type { BoundRequestModelInvocationContext } from "../request/contracts.js";
import { createSemanticCompactionSha256Fingerprint } from "../context/semantic-compaction/contracts.js";
import {
  buildSuperCompactionStageMessages,
  createSuperCompactionCapsule,
} from "../context/super-compaction/capsule.js";
import {
  invokeSuperCompactionStageText,
  invokeSuperContinuationText,
} from "../context/super-compaction/model-call.js";

function makeCapsule(
  authority?: "prior_conversation" | "settled_evidence",
  previousContinuation?: string,
) {
  const content = "Observed partial source with an explicit failure.";
  const fingerprint = createSemanticCompactionSha256Fingerprint(content);
  return createSuperCompactionCapsule({
    currentRequest: "Continue the assigned investigation.",
    authority,
    previousContinuation,
    assignment: {
      sourceRef: "evidence-1",
      objective: "Preserve the observed outcome.",
    },
    sourceSlice: {
      sourceRef: "evidence-1",
      sourceFingerprint: fingerprint,
      sliceFingerprint: fingerprint,
      range: {
        startByte: 0,
        endByteExclusive: Buffer.byteLength(content),
        totalBytes: Buffer.byteLength(content),
      },
      content,
    },
  });
}

function makePort(
  text: string,
  diagnostics: Partial<ModelStepOutputDiagnostics> = {},
) {
  const invocations: ModelStepInvocationInput<unknown>[] = [];
  const signal = new AbortController().signal;
  const request = {
    modelSteps: {
      async invoke<T>(input: ModelStepInvocationInput<T>): Promise<T> {
        invocations.push(input);
        return input.accept(
          text,
          { outputLength: text.length, ...diagnostics },
          signal,
        );
      },
    },
  } as BoundRequestModelInvocationContext;
  return { request, invocations };
}

describe("SUPER compaction stage primitives", () => {
  test("keeps one passive user envelope with identical base bytes across all stages", () => {
    const priorHandoff = "Earlier observed work remains part of the handoff.";
    const baseMessages = makeCapsule(undefined, priorHandoff);
    expect(
      JSON.parse(baseMessages[0]!.content).previousContinuation.content,
    ).toBe(priorHandoff);
    const sourceBytes = baseMessages[0]!.content;
    const coverage = "Only the supplied partial range is available.";
    const content = "The observed action failed.";
    const coverageMessages = buildSuperCompactionStageMessages({
      stage: "coverage",
      baseMessages,
      maxCharacters: 300,
    });
    const contentMessages = buildSuperCompactionStageMessages({
      stage: "content",
      baseMessages,
      maxCharacters: 500,
      derived: { coverage },
    });
    const continuationMessages = buildSuperCompactionStageMessages({
      stage: "continuation",
      baseMessages,
      maxCharacters: 200,
      derived: { coverage, content },
    });
    expect(Object.isFrozen(baseMessages)).toBe(true);
    expect(Object.isFrozen(baseMessages[0])).toBe(true);
    const envelopes = [
      coverageMessages,
      contentMessages,
      continuationMessages,
    ].map((messages) => {
      expect(messages.map(({ role }) => role)).toEqual(["system", "user"]);
      const envelope = JSON.parse(messages[1]!.content);
      expect(envelope.kind).toBe("runtime_super_compaction_stage_input_v1");
      expect(envelope.authority).toBe("passive_compaction_context");
      expect(JSON.stringify(envelope.baseCapsule)).toBe(sourceBytes);
      expect(envelope).not.toHaveProperty("currentRequest");
      expect(envelope.derivedStageOutputs.outputs).not.toHaveProperty(
        "currentRequest",
      );
      return envelope;
    });
    expect(
      envelopes.map((envelope) => envelope.derivedStageOutputs.outputs),
    ).toEqual([{}, { coverage }, { coverage, content }]);
    expect(coverageMessages[0]!.content).not.toBe(contentMessages[0]!.content);
    expect(baseMessages[0]!.content).toBe(sourceBytes);
    expect(sourceBytes).not.toContain(coverage);
    expect(sourceBytes).not.toContain(content);
  });

  test("preserves another canonical JSON base kind without changing the message topology", () => {
    const base = JSON.stringify({
      kind: "runtime_super_compaction_merge_input_v1",
      sourceRef: "source-1",
      slices: ["fact one", "fact two"],
    });
    const messages = buildSuperCompactionStageMessages({
      stage: "content",
      baseMessages: [{ role: "user", content: base }],
      maxCharacters: 500,
      derived: { coverage: "Two supplied ranges." },
    });
    expect(messages.map(({ role }) => role)).toEqual(["system", "user"]);
    expect(JSON.stringify(JSON.parse(messages[1]!.content).baseCapsule)).toBe(
      base,
    );
  });

  test("keeps historical evidence authority distinct without altering source or current request", () => {
    const settled = JSON.parse(makeCapsule()[0]!.content);
    const history = JSON.parse(makeCapsule("prior_conversation")[0]!.content);
    expect(settled.authority).toBe("settled_evidence");
    expect(history.authority).toBe("prior_conversation");
    expect(history.currentRequest).toBe(settled.currentRequest);
    expect(history.sourceSlice).toEqual(settled.sourceSlice);
    expect(history.assignment).toEqual(settled.assignment);
  });

  test("invokes the exact RAW stage once and forwards the frozen steering version", async () => {
    const { request, invocations } = makePort("  A bounded fact.  ");
    const output = await invokeSuperCompactionStageText({
      request,
      stage: "content",
      baseMessages: makeCapsule(),
      maxCharacters: 100,
      boundSteeringVersion: 4,
    });
    expect(output).toBe("A bounded fact.");
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      modelStep: MODEL_STEPS.SUPER_COMPACTION_CONTENT,
      contextRetention: "exact",
      format: { type: "text", calibrationInstructions: "omit" },
      boundSteeringVersion: 4,
    });
    expect(invocations[0]).not.toHaveProperty("contextCompaction");
  });

  test("preserves complete output beyond the writing target for actual context admission", async () => {
    const text = "Complete evidence with an explicit partial-read limitation.";
    const { request, invocations } = makePort(text);
    const output = await invokeSuperCompactionStageText({
      request,
      stage: "coverage",
      baseMessages: makeCapsule(),
      maxCharacters: 4,
    });
    expect(output).toBe(text);
    expect(invocations).toHaveLength(1);
  });

  test.each([
    {
      text: " \n",
      diagnostics: {},
      error: "invalid_super_compaction_coverage_output",
    },
    {
      text: "fact",
      diagnostics: { providerCompletionReason: "length" },
      error: "output_incomplete",
    },
  ])(
    "rejects $error without a second invocation",
    async ({ text, diagnostics, error }) => {
      const { request, invocations } = makePort(text, diagnostics);
      await expect(
        invokeSuperCompactionStageText({
          request,
          stage: "coverage",
          baseMessages: makeCapsule(),
          maxCharacters: 4,
        }),
      ).rejects.toThrow(error);
      expect(invocations).toHaveLength(1);
    },
  );

  test("uses the dedicated continuation step with the same mechanical output contract", async () => {
    const { request, invocations } = makePort(
      "Earlier action failed; work remains open.",
    );
    await invokeSuperContinuationText({
      request,
      baseMessages: makeCapsule(),
      maxCharacters: 100,
    });
    expect(invocations).toHaveLength(1);
    expect(invocations[0]!.modelStep).toBe(
      MODEL_STEPS.SUPER_COMPACTION_CONTINUATION,
    );
  });
});
