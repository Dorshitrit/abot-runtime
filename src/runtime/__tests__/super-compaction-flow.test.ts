import { describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { SemanticCompactionSourceSlice } from "../context/semantic-compaction/chunking.js";
import type { ModelGatewayClient } from "../ports.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";
import { projectSuperCompactionConfiguration } from "../context/super-compaction/configuration.js";
import { createCompactionRequest } from "./support/compaction-chunking-request-fixture.js";
import { prepareSuperCheckpointBudget } from "../context/super-compaction/checkpoint-budget.js";
import { generateSuperCompactionCandidate } from "../context/super-compaction/run.js";
import { createSuperSessionMemoryCompactor } from "../context/super-compaction/history.js";
import { SUPER_COMPACTION_WINDOW_BYTES } from "../context/super-compaction/windows.js";
import {
  createSemanticCompactionSha256Fingerprint,
  type SemanticCompactionSource,
} from "../context/semantic-compaction/contracts.js";
import {
  captureRequestContextCompaction,
  restoreRequestContextCompaction,
} from "../context/semantic-compaction/snapshot.js";
import type { SemanticCompactionGenerationParams } from "../context/semantic-compaction/generation-contracts.js";

function fixture(
  options: {
    incomplete?: boolean;
    coverageOutput?: string;
    contentOutput?: string;
    mergeOutput?: string;
  } = {},
) {
  const calls: Array<{
    step: string;
    capsule: string;
    data: {
      sourceSlice: SemanticCompactionSourceSlice;
      authority: string;
      currentRequest: string;
      sourceAuthority?: string;
    };
  }> = [];
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    const envelope = (input.messages as readonly ChatMessage[]).find(
      (message) => message.role === "user",
    )!;
    const capsule = JSON.stringify(JSON.parse(envelope.content).baseCapsule);
    const step = input.modelStep!;
    calls.push({ step, capsule, data: JSON.parse(capsule) });
    const text =
      step === "super.compact.coverage"
        ? (options.coverageOutput ?? "Read lines14-21/84; next22; incomplete.")
        : step === "super.compact.content"
          ? (options.contentOutput ??
            "ttl=0 gives Infinity; selected tests1 failed2 passed; full suite not run.")
          : step === "super.compact.merge"
            ? (options.mergeOutput ??
              "Read lines14-21/84; next22; incomplete. ttl=0 gives Infinity; selected tests1 failed2 passed; full suite not run.")
            : "The observed zero-TTL case fails; no mutation or full-suite pass is evidenced.";
    return {
      text,
      meta: options.incomplete ? { providerCompletionReason: "length" } : {},
    };
  });
  const original = createCompactionRequest({
    requestId: "super-flow",
    prompt: "Investigate TTL behavior",
    invoke,
  });
  const configuration = projectSuperCompactionConfiguration(
    original,
    original.executionPolicy.authority,
  );
  const request = deriveTestRequestExecutionScope(original, configuration);
  const content =
    JSON.stringify({ lines: [14, 21], totalLines: 84, nextLine: 22 }) +
    "\nObserved ttl=0 yields Infinity; partial test failed. עברית🙂\n".repeat(
      180,
    );
  const source: SemanticCompactionSource = {
    sourceRef: "receipt-1",
    content,
    sourceFingerprint: createSemanticCompactionSha256Fingerprint(content),
  };
  const objective = "Preserve the observed development evidence";
  const params: SemanticCompactionGenerationParams = {
    request,
    scopeId: "role:worker:flow",
    sourceRevision: 1,
    preservationObjective: objective,
    binding: {
      requestId: request.requestId,
      currentRequestFingerprint: createSemanticCompactionSha256Fingerprint(
        request.prompt,
      ),
      roleId: "worker",
      callId: "worker-flow",
      objectiveFingerprint:
        createSemanticCompactionSha256Fingerprint(objective),
      contextLane: "role_continuation",
      allowedConsumers: ["worker.result"],
    },
    consumer: "worker.result",
    sources: [source],
  };
  return { request, source, params, calls, invoke };
}

describe("independent SUPER compaction flow", () => {
  test("extracts contiguous independent windows and shares each unit context between its stages", async () => {
    const f = fixture();
    const candidate = await generateSuperCompactionCandidate(f.params);
    expect(f.calls.length).toBeGreaterThan(3);
    const slices: SemanticCompactionSourceSlice[] = [];
    const extractionCalls = f.calls.filter(
      (call) =>
        call.step === "super.compact.coverage" ||
        call.step === "super.compact.content",
    );
    for (let index = 0; index < extractionCalls.length; index += 2) {
      const stages = extractionCalls.slice(index, index + 2);
      expect(stages.map((call) => call.step)).toEqual([
        "super.compact.coverage",
        "super.compact.content",
      ]);
      expect(new Set(stages.map((call) => call.capsule)).size).toBe(1);
      const slice = stages[0]!.data.sourceSlice;
      expect(
        slice.range.endByteExclusive - slice.range.startByte,
      ).toBeLessThanOrEqual(SUPER_COMPACTION_WINDOW_BYTES);
      expect(slice.range.startByte).toBe(
        slices.at(-1)?.range.endByteExclusive ?? 0,
      );
      slices.push(slice);
    }
    expect(
      f.calls.filter((call) => call.step === "super.compact.continuation"),
    ).toHaveLength(1);
    expect(f.calls.at(-1)!.capsule).toBe(f.calls.at(-2)!.capsule);
    expect(
      extractionCalls.every(
        (call) => !Object.hasOwn(call.data, "previousFold"),
      ),
    ).toBe(true);
    expect(slices.map((slice) => slice.content).join("")).toBe(
      f.source.content,
    );
    expect(slices.at(-1)!.range.endByteExclusive).toBe(
      Buffer.byteLength(f.source.content),
    );
    expect(candidate.sourceDigests[0]!.digest).toContain("next22");
    expect(candidate.sourceDigests[0]!.digest.length).toBeLessThan(
      f.source.content.length,
    );
    expect(
      f.request.contextCompactionStore!.get(f.params.scopeId),
    ).toBeUndefined();
    f.request.contextCompactionStore!.commit(candidate);
    const restored = restoreRequestContextCompaction(
      captureRequestContextCompaction(f.request.contextCompactionStore!),
    );
    expect(restored.get(f.params.scopeId)).toEqual(candidate);
    expect(
      restored.materializeSource(
        f.source.sourceRef,
        f.source.sourceFingerprint,
      ),
    ).toEqual(f.source);
  });

  test("admits an oversized writing draft when the complete checkpoint fits", async () => {
    const coverageOutput = "Partial coverage; ".repeat(24);
    const contentOutput = "Observed evidence. ".repeat(108);
    const f = fixture({
      coverageOutput,
      contentOutput,
      mergeOutput: `${coverageOutput}\n${contentOutput}`,
    });
    const planned = await prepareSuperCheckpointBudget(f.params, [f.source]);
    const candidate = await generateSuperCompactionCandidate(f.params);
    const digest = candidate.sourceDigests[0]!.digest;
    expect(digest.length).toBeGreaterThan(planned.sourceCharacterLimits[0]!);
    expect(digest).toContain(coverageOutput.trim());
    expect(digest).toContain(contentOutput.trim());
    expect(
      f.request.contextCompactionStore!.get(f.params.scopeId),
    ).toBeUndefined();
    f.request.contextCompactionStore!.commit(candidate);
    expect(f.request.contextCompactionStore!.get(f.params.scopeId)).toEqual(
      candidate,
    );
  });

  test("retains old checkpoint sources while adding fresh evidence", async () => {
    const f = fixture();
    const previous = await generateSuperCompactionCandidate(f.params);
    f.request.contextCompactionStore!.commit(previous);
    const content = "Selected TTL test now passes. Full suite still not run.\n";
    const fresh = {
      sourceRef: "receipt-2",
      content,
      sourceFingerprint: createSemanticCompactionSha256Fingerprint(content),
    };
    const candidate = await generateSuperCompactionCandidate({
      ...f.params,
      previous,
      sourceRevision: 2,
      sources: [fresh],
    });
    expect(candidate.sourceDigests.map(({ sourceRef }) => sourceRef)).toEqual([
      "receipt-1",
      "receipt-2",
    ]);
    expect(candidate.sourceDigests[0]).toEqual(previous.sourceDigests[0]);
    expect(candidate.sourceDigests[1]!.digest).toContain(content);
    expect(f.request.contextCompactionStore!.get(f.params.scopeId)).toEqual(
      previous,
    );
  });

  test("an incomplete provider output leaves the checkpoint untouched without retries", async () => {
    const f = fixture({ incomplete: true });
    await expect(generateSuperCompactionCandidate(f.params)).rejects.toThrow(
      "output_incomplete",
    );
    expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(
      f.request.contextCompactionStore!.get(f.params.scopeId),
    ).toBeUndefined();
  });

  test("history uses independent coverage/content stages and stays prior conversation", async () => {
    const f = fixture();
    const summary = await createSuperSessionMemoryCompactor().compact({
      request: f.request,
      previousSummary: "Earlier work remained unverified.",
      turns: [
        {
          userMessages: [
            {
              id: "user-1",
              role: "user",
              createdAt: "2026-10-24T00:00:00Z",
              content: "Explain TTL behavior. ".repeat(180),
            },
          ],
          assistant: {
            id: "assistant-1",
            role: "assistant",
            createdAt: "2026-10-24T00:00:01Z",
            content: "A partial test failed.",
          },
        },
      ],
    });
    expect(summary).toContain("full suite not run");
    expect(new Set(f.calls.map((call) => call.step))).toEqual(
      new Set([
        "super.compact.coverage",
        "super.compact.content",
        "super.compact.merge",
      ]),
    );
    expect(
      f.calls.every(
        (call) =>
          (call.data.sourceAuthority ?? call.data.authority) ===
          "prior_conversation",
      ),
    ).toBe(true);
    expect(f.calls.every((call) => call.data.currentRequest === "")).toBe(true);
    const historyWindows = f.calls.filter(
      (call) => call.step !== "super.compact.merge",
    );
    for (let index = 0; index < historyWindows.length; index += 2)
      expect(historyWindows[index]!.capsule).toBe(
        historyWindows[index + 1]!.capsule,
      );
  });
});
