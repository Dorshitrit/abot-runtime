import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { resolveModelInvocation } from "../../model-gateway/invocation-policy.js";
import type { ModelGatewayClient } from "../ports.js";
import { createSemanticCompactionSha256Fingerprint as hash } from "../context/semantic-compaction/contracts.js";
import { createSemanticCompactionSourceSlice, projectSemanticCompactionUtf8Boundaries, type SemanticCompactionSourceSlice } from "../context/semantic-compaction/chunking.js";
import { projectSuperCompactionConfiguration } from "../context/super-compaction/configuration.js";
import { createSuperCompactionCapsule } from "../context/super-compaction/capsule.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { selectSuperCompactionWindow } from "../context/super-compaction/windows.js";
import { doesSuperCompactionPipelineFit, invokeSuperCompactionStageText } from "../context/super-compaction/model-call.js";
import { createCompactionRequest } from "./support/compaction-chunking-request-fixture.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(resetDebugLoggerConfig);

const limits = { coverage: 100, content: 300, continuation: 200 };
const guidance = "CONFIGURED_WINDOW_GUIDANCE";
const calibration = "OMITTED_CALIBRATION_GUIDANCE";

test("a source larger than 4KB stays whole when every measured stage fits", async () => {
  const f = fixture("Evidence with preserved whitespace.\n".repeat(250));
  const selected = await selectSuperCompactionWindow(f.params);
  const slice = readSlice(selected.baseMessages);
  expect(Buffer.byteLength(slice.content)).toBeGreaterThan(4_096);
  expect(selected.endBoundaryIndex).toBe(f.params.boundaries.length - 1);
  expect(slice.content).toBe(f.params.source.content);
  expect(f.measurements.map(({ step }) => step)).toEqual([
    "super.compact.coverage", "super.compact.content", "super.compact.continuation",
  ]);
  assertAdmitted(f, slice);
  expect(f.invoke).not.toHaveBeenCalled();
});

test.each(["content", "continuation"] as const)(
  "the smaller %s profile bounds UTF-8 windows using its complete envelope and reserves",
  async (narrowStage) => {
    const f = fixture("עברית🙂 evidence\n".repeat(700), { narrowStage });
    const slices: SemanticCompactionSourceSlice[] = [];
    let startBoundaryIndex = 0;
    while (startBoundaryIndex < f.params.boundaries.length - 1) {
      const selected = await selectSuperCompactionWindow({ ...f.params, startBoundaryIndex });
      const slice = readSlice(selected.baseMessages);
      expect(slice.range.startByte).toBe(slices.at(-1)?.range.endByteExclusive ?? 0);
      expect(Buffer.byteLength(slice.content)).toBe(slice.range.endByteExclusive - slice.range.startByte);
      expect(slice.sliceFingerprint).toBe(hash(slice.content));
      expect(slice.sourceFingerprint).toBe(f.params.source.sourceFingerprint);
      expect(slice.content).not.toContain("\uFFFD");
      assertAdmitted(f, slice);
      slices.push(slice);
      startBoundaryIndex = selected.endBoundaryIndex;
    }
    expect(slices.length).toBeGreaterThan(1);
    expect(slices.map(({ content }) => content).join("")).toBe(f.params.source.content);
    expect(slices.at(-1)!.range.endByteExclusive).toBe(Buffer.byteLength(f.params.source.content));
    const measurements = f.measurements.filter(({ step }) => step === `super.compact.${narrowStage}`);
    expect(measurements.every(({ profileId }) => profileId === "narrow")).toBe(true);
    expect(measurements.some(({ tokens }) => tokens + reserve(narrowStage) > f.narrowWindow - 2_548)).toBe(true);
    for (const measured of f.measurements) {
      expect(measured.messages.some(({ content }) => content.includes(guidance))).toBe(true);
      expect(JSON.stringify(measured.messages)).not.toContain(calibration);
      expect(measured.format).toMatchObject({ type: "text", calibrationInstructions: "omit" });
      const base = JSON.parse(measured.messages.find(({ role }) => role === "user")!.content).baseCapsule;
      expect(base.currentRequest).toBe(f.params.currentRequest);
      expect(base.assignment).toEqual(f.params.assignment);
      expect(base.previousContinuation.content).toBe(f.params.previousContinuation);
    }
    expect(f.invoke).not.toHaveBeenCalled();
  },
);

test("a measured window that fits input alone still reserves pending stage output", async () => {
  const f = fixture("x".repeat(15_000), { narrowStage: "continuation" });
  const selected = await selectSuperCompactionWindow(f.params);
  const slice = readSlice(selected.baseMessages);
  const selectedCount = f.measurements.find(({ step, sourceContent }) =>
    step === "super.compact.continuation" && sourceContent === slice.content)!;
  const available = f.narrowWindow - 2_548;
  expect(selectedCount.tokens + reserve("continuation")).toBeLessThanOrEqual(available);
  const largerBase = createSuperCompactionCapsule({ ...f.params, sourceSlice: createSemanticCompactionSourceSlice({
    ...f.params, endBoundaryIndex: selected.endBoundaryIndex + 1,
  }) });
  expect(await doesSuperCompactionPipelineFit({ ...f.params, baseMessages: largerBase })).toBe(false);
  const rejected = f.measurements.at(-1)!;
  expect(rejected.step).toBe("super.compact.continuation");
  expect(rejected.tokens).toBeLessThan(available);
  expect(rejected.tokens + reserve("continuation")).toBeGreaterThan(available);
});

test("actual stage output is admitted in full even when it exceeds the planned target", async () => {
  const oversized = "Complete evidence. ".repeat(3_000);
  const f = fixture("source ".repeat(800), { output: oversized });
  const selected = await selectSuperCompactionWindow(f.params);
  const coverage = await invokeSuperCompactionStageText({
    request: f.params.request, baseMessages: selected.baseMessages,
    stage: "coverage", maxCharacters: limits.coverage,
  });
  expect(coverage).toBe(oversized.trim());
  await expect(invokeSuperCompactionStageText({
    request: f.params.request, baseMessages: selected.baseMessages,
    stage: "content", maxCharacters: limits.content, derived: { coverage },
  })).rejects.toThrow("request_context_final_envelope_exceeds_window");
  expect(f.invoke).toHaveBeenCalledTimes(1);
});

test("rejects when even one code point cannot fit and does not invoke a model", async () => {
  const f = fixture("🙂", { narrowStage: "continuation", narrowWindow: 3_000 });
  await expect(selectSuperCompactionWindow(f.params)).rejects.toThrow("super_compaction_input_exceeds_budget");
  expect(f.invoke).not.toHaveBeenCalled();
});

test("an aborted selection performs no counting or model invocation", async () => {
  const f = fixture("evidence".repeat(1_000));
  f.controller.abort(new Error("window_selection_cancelled"));
  await expect(selectSuperCompactionWindow(f.params)).rejects.toThrow("window_selection_cancelled");
  expect(f.measurements).toEqual([]);
  expect(f.invoke).not.toHaveBeenCalled();
});

test("retains estimated-budget admission when provider counting is unavailable", async () => {
  const f = fixture("evidence ".repeat(1_000));
  const request = deriveTestRequestExecutionScope(f.params.request, {
    modelGatewayClient: { ...f.params.request.modelGatewayClient, countInputTokens: undefined },
  });
  const selected = await selectSuperCompactionWindow({ ...f.params, request });
  expect(readSlice(selected.baseMessages).content).toBe(f.params.source.content);
  expect(f.measurements).toEqual([]);
  expect(f.invoke).not.toHaveBeenCalled();
});

function reserve(stage: string): number {
  return stage === "coverage" ? 0 : stage === "content" ? 3 * limits.coverage : 3 * (limits.coverage + limits.content);
}

function readSlice(messages: readonly ChatMessage[]): SemanticCompactionSourceSlice {
  return JSON.parse(messages[0]!.content).sourceSlice;
}

function assertAdmitted(f: ReturnType<typeof fixture>, slice: SemanticCompactionSourceSlice) {
  for (const stage of ["coverage", "content", "continuation"]) {
    const measurement = f.measurements.find(({ step, sourceContent, startByte, endByte }) =>
      step === `super.compact.${stage}` && sourceContent === slice.content &&
      startByte === slice.range.startByte && endByte === slice.range.endByteExclusive)!;
    expect(measurement).toBeDefined();
    expect(measurement.tokens + reserve(stage)).toBeLessThanOrEqual(measurement.window - 2_548);
  }
}

function fixture(content: string, options: {
  narrowStage?: "content" | "continuation"; narrowWindow?: number; output?: string;
} = {}) {
  const controller = new AbortController();
  const measurements: Array<{ step: string; sourceContent: string; messages: readonly ChatMessage[];
    profileId: string; tokens: number; window: number; format: unknown; startByte: number; endByte: number }> = [];
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => ({ text: options.output ?? "Partial evidence.", meta: {} }));
  const countInputTokens: NonNullable<ModelGatewayClient["countInputTokens"]> = async (input) => {
    const invocation = resolveModelInvocation(input);
    const messages = input.messages as readonly ChatMessage[];
    const tokens = Math.ceil(Buffer.byteLength(JSON.stringify(messages)) / 2);
    const base = JSON.parse(messages.find(({ role }) => role === "user")!.content).baseCapsule;
    measurements.push({ step: input.modelStep!, sourceContent: base.sourceSlice.content, messages,
      profileId: invocation.profile.id, tokens, window: invocation.profile.contextWindowTokens, format: input.format,
      startByte: base.sourceSlice.range.startByte, endByte: base.sourceSlice.range.endByteExclusive });
    return { inputTokens: tokens, profileId: invocation.profile.id, provider: invocation.profile.provider,
      model: invocation.model, contextWindowTokens: invocation.profile.contextWindowTokens, source: "provider_input_token_count" };
  };
  const original = createCompactionRequest({ requestId: "super-window-budget", prompt: "Preserve observed evidence.", invoke });
  const configuration = projectSuperCompactionConfiguration(original, original.executionPolicy.authority);
  const policy = configuration.modelPolicy!;
  const narrowWindow = options.narrowWindow ?? 8_000;
  const request = deriveTestRequestExecutionScope(original, {
    ...configuration, abortSignal: controller.signal,
    modelGatewayClient: { ...original.modelGatewayClient, countInputTokens },
    modelPolicy: { ...policy,
      profiles: { ...policy.profiles, narrow: { provider: "test", model: "narrow", contextWindowTokens: narrowWindow,
        calibration: { [ `super.compact.${options.narrowStage}` ]: { instructions: [calibration] } } } },
      defaults: { ...policy.defaults, steps: { ...policy.defaults?.steps,
        ...(options.narrowStage ? { [`super.compact.${options.narrowStage}`]: "narrow" } : {}),
      } },
    },
    runnerConfig: { ...configuration.runnerConfig, steps: { ...configuration.runnerConfig.steps,
      ...Object.fromEntries(["coverage", "content", "continuation"].map((stage) => [`super.compact.${stage}`, {
        timeoutMs: 20_000, instructionBlocks: [{ ref: "window-test", content: guidance, contentHash: hash(guidance) }],
      }])),
    } },
  });
  return { measurements, invoke, controller, narrowWindow, params: {
    request, currentRequest: request.prompt,
    assignment: { objective: "Preserve all supplied evidence", context: "assignment detail ".repeat(40) },
    previousContinuation: "Previous partial findings. ".repeat(20),
    source: { sourceRef: "window-source", content, sourceFingerprint: hash(content) },
    boundaries: projectSemanticCompactionUtf8Boundaries(content), startBoundaryIndex: 0, limits,
  } };
}
