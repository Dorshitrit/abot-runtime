import { describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { resolveModelInvocation } from "../../model-gateway/invocation-policy.js";
import type { ModelGatewayClient } from "../ports.js";
import type { RequestToolResult } from "../context/request-tool-results.js";
import { createCapabilityResultCompactionSource } from "../context/capability-result-compaction-source.js";
import { projectCompactionSourceInput } from "../context/compaction-source-input.js";
import { generateSuperCompactionCandidate } from "../context/super-compaction/run.js";
import { projectSuperCompactionConfiguration } from "../context/super-compaction/configuration.js";
import { prepareSuperCheckpointBudget } from "../context/super-compaction/checkpoint-budget.js";
import {
  createSemanticCompactionSha256Fingerprint as hash,
  type SemanticCompactionSource,
} from "../context/semantic-compaction/contracts.js";
import type { SemanticCompactionSourceSlice } from "../context/semantic-compaction/chunking.js";
import type { SemanticCompactionGenerationParams } from "../context/semantic-compaction/generation-contracts.js";
import { createRequestContextCompactionStore } from "../context/semantic-compaction/store.js";
import {
  captureRequestContextCompaction,
  restoreRequestContextCompaction,
} from "../context/semantic-compaction/snapshot.js";
import { createCompactionRequest } from "./support/compaction-chunking-request-fixture.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";

function sourceFor(
  output: string,
  referenceData = output.trim(),
  executionId = "execution-1",
) {
  const receipt: RequestToolResult = {
    executionId,
    callId: "worker-1",
    invocationAttempt: 1,
    capabilityId: "read",
    declaredEffect: "observation",
    outcome: "succeeded",
    observedEffect: "observation",
    summary: "Read the selected source.",
    referenceData,
    references: [{ kind: "tool_target", target: "input.txt" }],
    adapterResult: {
      kind: "registered_tool_execution_result_v1",
      authority: "registered_plugin",
      status: "executed",
      result: {
        ok: true,
        tool: "read",
        producedNewInformation: true,
        output,
        data: { sourceLabel: "primary" },
      },
    },
  };
  return createCapabilityResultCompactionSource(receipt);
}

function sourceWith(
  content: string,
  sourceRef = "execution-1",
): SemanticCompactionSource {
  return { sourceRef, content, sourceFingerprint: hash(content) };
}

describe("SUPER compactor source input", () => {
  test.each([
    "  content\n",
    "\nעברית🙂\n\n",
    " ".repeat(33_000) + "bounded body\n",
  ])(
    "omits only the known normalized alias while preserving exact output",
    (output) => {
      const source = sourceFor(output);
      const original = JSON.parse(source.content);
      const projected = projectCompactionSourceInput(source);
      const view = JSON.parse(projected.content);
      expect(view).not.toHaveProperty("referenceData");
      const { referenceData: _alias, ...remaining } = original;
      expect(view).toEqual(remaining);
      expect(view.adapterResult.result.output).toBe(output);
      expect(projected.sourceFingerprint).toBe(hash(projected.content));
      expect(projected.sourceFingerprint).not.toBe(source.sourceFingerprint);
      expect(source.content).toBe(JSON.stringify(original));
      expect(source.sourceFingerprint).toBe(hash(source.content));
    },
  );

  test.each(["independent supplementary evidence", "  content", "CONTENT"])(
    "keeps a distinct reference body byte-identical",
    (referenceData) => {
      const source = sourceFor("  content\n", referenceData);
      expect(projectCompactionSourceInput(source)).toBe(source);
    },
  );

  test("keeps an already single-copy source and unknown source shapes unchanged", () => {
    const source = sourceFor("content");
    expect(projectCompactionSourceInput(source)).toBe(source);
    const receipt = JSON.parse(sourceFor(" content ").content);
    for (const unknown of [
      sourceWith(JSON.stringify({ user: receipt })),
      sourceWith(JSON.stringify({ ...receipt, unknown: true })),
      sourceWith(JSON.stringify(receipt), "different-execution"),
      sourceWith(
        JSON.stringify({ role: "user", content: JSON.stringify(receipt) }),
      ),
      sourceWith("The referenceData field in this document is an example."),
    ])
      expect(projectCompactionSourceInput(unknown)).toBe(unknown);
  });

  test.each([
    { output: "content", referenceData: "content" },
    { output: "  content\n", referenceData: "content" },
    { output: "  content\n", referenceData: "  content\n" },
  ])(
    "payload sources omit exact or normalized output aliases without changing their source reference",
    ({ output, referenceData }) => {
      const receipt = JSON.parse(sourceFor(" original ").content);
      receipt.adapterResult.result.output = output;
      receipt.referenceData = referenceData;
      const source = sourceWith(
        JSON.stringify(receipt),
        "payload-result:execution-1",
      );
      const projected = projectCompactionSourceInput(source);
      const { referenceData: _alias, ...remaining } = receipt;
      expect(projected.content).toBe(JSON.stringify(remaining));
      expect(projected.sourceRef).toBe(source.sourceRef);
      expect(projected.sourceFingerprint).toBe(hash(projected.content));
      expect(JSON.parse(projected.content).adapterResult.result.output).toBe(
        output,
      );
      expect(source.content).toBe(JSON.stringify(receipt));
    },
  );

  test("payload sources retain supplementary bodies, different owners and unknown fields", () => {
    const receipt = JSON.parse(sourceFor(" content ").content);
    const cases = [
      sourceWith(
        JSON.stringify({ ...receipt, referenceData: "independent evidence" }),
        "payload-result:execution-1",
      ),
      sourceWith(JSON.stringify(receipt), "payload-result:another-execution"),
      sourceWith(JSON.stringify(receipt), "other-result:execution-1"),
      sourceWith(
        JSON.stringify({ ...receipt, unknown: true }),
        "payload-result:execution-1",
      ),
      sourceWith(
        JSON.stringify({
          ...receipt,
          adapterResult: {
            kind: "generic_capability_result_v1",
            authority: "capability_adapter",
            status: "executed",
            ok: true,
            payload: { referenceData: receipt.referenceData },
          },
        }),
        "payload-result:execution-1",
      ),
    ];
    for (const source of cases)
      expect(projectCompactionSourceInput(source)).toBe(source);
  });

  test("rejects changed canonical bytes before making a view", () => {
    const source = sourceFor(" body ");
    expect(() =>
      projectCompactionSourceInput({
        ...source,
        content: source.content + " ",
      }),
    ).toThrow("context_compaction_source_content_mismatch");
  });
});

function generationFixture(source: SemanticCompactionSource, split = false) {
  const sent: Array<{ step: string; slice?: SemanticCompactionSourceSlice }> =
    [];
  const counted = new Set<string>();
  const readSlice = (messages: readonly ChatMessage[]) => {
    const user = messages.find((message) => message.role === "user");
    if (!user) return undefined;
    return JSON.parse(user.content).baseCapsule?.sourceSlice as
      | SemanticCompactionSourceSlice
      | undefined;
  };
  const store = createRequestContextCompactionStore();
  store.registerSources([source]);
  // Model an original duplicate source saved before the fix, without rewriting it.
  const saved = captureRequestContextCompaction(store);
  const restored = restoreRequestContextCompaction(saved);
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    const slice = readSlice(input.messages as readonly ChatMessage[]);
    sent.push({ step: input.modelStep!, slice });
    if (slice)
      expect(counted.has(`${input.modelStep}:${JSON.stringify(slice)}`)).toBe(
        true,
      );
    return {
      text:
        input.modelStep === "super.compact.coverage"
          ? "Observed the supplied range; no missing-data claim."
          : "Preserve the observed identifier and unfinished verification.",
      meta: {},
    };
  });
  const original = createCompactionRequest({
    requestId: "deduplicated-compaction",
    prompt: "Continue using the observed source.",
    store: restored,
    invoke,
    countInputTokens: async (input) => {
      const slice = readSlice(input.messages as readonly ChatMessage[]);
      if (slice) counted.add(`${input.modelStep}:${JSON.stringify(slice)}`);
      const invocation = resolveModelInvocation(input);
      return {
        inputTokens: Math.ceil(
          Buffer.byteLength(JSON.stringify(input.messages)) / (split ? 1 : 4),
        ),
        profileId: invocation.profile.id,
        provider: invocation.profile.provider,
        model: invocation.model,
        contextWindowTokens: invocation.profile.contextWindowTokens,
        source: "provider_input_token_count" as const,
      };
    },
  });
  const request = deriveTestRequestExecutionScope(
    original,
    projectSuperCompactionConfiguration(
      original,
      original.executionPolicy.authority,
    ),
  );
  const objective = "Preserve the observed source and remaining work";
  const params: SemanticCompactionGenerationParams = {
    request,
    scopeId: "role:worker:dedup",
    sourceRevision: 1,
    preservationObjective: objective,
    binding: {
      requestId: request.requestId,
      currentRequestFingerprint: hash(request.prompt),
      roleId: "worker",
      callId: "worker-1",
      objectiveFingerprint: hash(objective),
      contextLane: "role_continuation",
      allowedConsumers: ["worker.result"],
    },
    consumer: "worker.result",
    sources: [source],
  };
  return { params, request, sent, saved };
}

test("counting and sending use the same single-copy UTF-8 windows; stored identities survive restore", async () => {
  const source = sourceFor(
    "  START\n" +
      "Observed עברית🙂 identity=42; pending test.\n".repeat(700) +
      "END\n",
  );
  const input = projectCompactionSourceInput(source);
  const fixture = generationFixture(source, true);
  const candidate = await generateSuperCompactionCandidate(fixture.params);
  const slices = fixture.sent
    .filter((call) => call.step === "super.compact.coverage")
    .map((call) => call.slice!);
  expect(slices.length).toBeGreaterThan(1);
  expect(slices.map((slice) => slice.content).join("")).toBe(input.content);
  let nextByte = 0;
  for (const slice of slices) {
    expect(slice.sourceFingerprint).toBe(input.sourceFingerprint);
    expect(slice.sliceFingerprint).toBe(hash(slice.content));
    expect(slice.range.startByte).toBe(nextByte);
    expect(Buffer.byteLength(slice.content)).toBe(
      slice.range.endByteExclusive - nextByte,
    );
    nextByte = slice.range.endByteExclusive;
  }
  expect(nextByte).toBe(Buffer.byteLength(input.content));
  expect(candidate.sourceDigests[0]).toMatchObject({
    sourceRef: source.sourceRef,
    sourceFingerprint: source.sourceFingerprint,
  });
  expect(
    captureRequestContextCompaction(fixture.request.contextCompactionStore!),
  ).toEqual(fixture.saved);
  fixture.request.contextCompactionStore!.commit(candidate);
  const restored = restoreRequestContextCompaction(
    captureRequestContextCompaction(fixture.request.contextCompactionStore!),
  );
  expect(restored.get(fixture.params.scopeId)).toEqual(candidate);
  expect(
    restored.materializeSource(source.sourceRef, source.sourceFingerprint),
  ).toEqual(source);
  expect(
    restored.materializeSource(input.sourceRef, input.sourceFingerprint),
  ).toBeUndefined();
});

test("retained small sources use one copy in digest and continuation without changing their stored identity", async () => {
  const source = sourceFor("  small evidence\n");
  const input = projectCompactionSourceInput(source);
  const fixture = generationFixture(source);
  const candidate = await generateSuperCompactionCandidate(fixture.params);
  expect(fixture.sent.map((call) => call.step)).toEqual([
    "super.compact.continuation",
  ]);
  expect(fixture.sent[0]!.slice!.content).toBe(input.content);
  expect(candidate.sourceDigests[0]).toEqual({
    sourceRef: source.sourceRef,
    sourceFingerprint: source.sourceFingerprint,
    digest: `Retained source (verbatim):\n${input.content}\nEnd of retained source.`,
  });
});

test("deduplication does not select the verbatim retention path using a smaller view", async () => {
  const source = sourceFor(" " + "source evidence ".repeat(90) + "\n");
  const input = projectCompactionSourceInput(source);
  const fixture = generationFixture(source);
  const { sourceCharacterLimits } = await prepareSuperCheckpointBudget(
    fixture.params,
    [source],
  );
  expect(input.content.length + 55).toBeLessThan(sourceCharacterLimits[0]!);
  expect(source.content.length).toBeGreaterThan(sourceCharacterLimits[0]!);
  await generateSuperCompactionCandidate(fixture.params);
  expect(fixture.sent[0]!.step).toBe("super.compact.coverage");
});

test("a restored checkpoint reuses original source identities when fresh evidence is compacted", async () => {
  const oldSource = sourceFor("  earlier evidence ".repeat(300) + "\n");
  const fixture = generationFixture(oldSource);
  const previous = await generateSuperCompactionCandidate(fixture.params);
  fixture.request.contextCompactionStore!.commit(previous);
  const snapshot = captureRequestContextCompaction(
    fixture.request.contextCompactionStore!,
  );
  const restored = restoreRequestContextCompaction(snapshot);
  const request = deriveTestRequestExecutionScope(fixture.request, {
    contextCompactionStore: restored,
  });
  const freshSource = sourceFor(
    "  Fresh result with pending verification.\n",
    undefined,
    "execution-2",
  );
  fixture.sent.length = 0;
  const resumed = await generateSuperCompactionCandidate({
    ...fixture.params,
    request,
    previous: restored.get(fixture.params.scopeId),
    sourceRevision: 2,
    sources: [freshSource],
  });
  expect(resumed.sourceDigests[0]).toEqual(previous.sourceDigests[0]);
  expect(resumed.sourceDigests[1]).toMatchObject({
    sourceRef: freshSource.sourceRef,
    sourceFingerprint: freshSource.sourceFingerprint,
  });
  expect(fixture.sent.length).toBeGreaterThan(0);
  for (const call of fixture.sent) {
    expect(call.slice!.sourceRef).toBe(freshSource.sourceRef);
    expect(call.slice!.content).toBe(
      projectCompactionSourceInput(freshSource).content,
    );
  }
  expect(restored.get(fixture.params.scopeId)).toEqual(previous);
  restored.commit(resumed);
  const nextSnapshot = captureRequestContextCompaction(restored);
  expect(nextSnapshot.sources).toEqual([oldSource, freshSource]);
  expect(nextSnapshot.sources).not.toContainEqual(
    projectCompactionSourceInput(oldSource),
  );
  expect(nextSnapshot.sources).not.toContainEqual(
    projectCompactionSourceInput(freshSource),
  );
  expect(
    restoreRequestContextCompaction(nextSnapshot).get(fixture.params.scopeId),
  ).toEqual(resumed);
});
