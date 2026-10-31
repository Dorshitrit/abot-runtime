import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { ModelStep } from "../../shared/model-steps.js";
import { createModelStepCompactionController } from "../context/model-step-compaction.js";
import { createRequestContextCompactionStore } from "../context/semantic-compaction/index.js";
import { ModelStepSteeringSupersededError } from "../model/model-step-steering.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import {
  ADMISSION_MESSAGES,
  createAdmissionFixture,
} from "./support/compaction-admission-fixture.js";
import {
  compactContinuation,
  readCompactionEnvelope,
} from "./support/semantic-compaction-contract-fixture.js";
import { semanticCompactionReplacementSlots } from "./support/semantic-compaction-replacement-fixture.js";
import { executionCompactionSteeringFixture } from "./support/execution-compaction-steering-fixture.js";
import { createTestRequestExecutionScope } from "./support/request-execution-scope.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

const STEERING_TEXT = "Use the newly supplied direction.";
const GENERATION_PATHS = ["batch", "slice", "repair", "slice_repair"] as const;
type GenerationPath = (typeof GENERATION_PATHS)[number];
type CompactionEnvelope = ReturnType<typeof readCompactionEnvelope>;

test.each(GENERATION_PATHS)(
  "bound EA completes nested %s compaction before returning pending steering to root",
  async (path) => {
    const f = createNestedCompactionFixture(path, "execution.decision");
    await expect(f.run(0)).rejects.toBeInstanceOf(
      ModelStepSteeringSupersededError,
    );
    assertCompletedGeneration(f, path);
    expect(f.parentCalls()).toHaveLength(0);
    const compactedCalls = f.compactionCalls().length;
    await expect(f.run(1)).resolves.toBe("ok");
    expect(f.compactionCalls()).toHaveLength(compactedCalls);
    expect(f.parentCalls()).toHaveLength(1);
  },
);

test.each(GENERATION_PATHS)(
  "unbound SUPER completes nested %s compaction before rebuilding its parent",
  async (path) => {
    const f = createNestedCompactionFixture(path, "supervisor.decision");
    await expect(f.run()).resolves.toBe("ok");
    assertCompletedGeneration(f, path);
    const parentCalls = f.parentCalls();
    expect(parentCalls).toHaveLength(1);
    const messages = parentCalls[0]![0].messages as readonly ChatMessage[];
    const steering = JSON.parse(messages.at(-1)!.content);
    expect(steering).toMatchObject({
      authority: "user",
      version: 1,
      updates: [{ sequence: 1, text: STEERING_TEXT }],
    });
  },
);

test.each(GENERATION_PATHS)(
  "an unbound Worker finishes %s compaction under its unchanged delegated assignment",
  async (path) => {
    const f = createNestedCompactionFixture(path, "worker.decision");
    await expect(f.run()).resolves.toBe("ok");
    expect(f.compactionCalls().length).toBeGreaterThan(1);
    const checkpoints = f.store.snapshot!().checkpoints;
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]!.sourceDigests).toHaveLength(f.evidence.length);
    expect(f.parentCalls()).toHaveLength(1);
    expect(JSON.stringify(f.parentCalls()[0]![0].messages)).not.toContain(
      STEERING_TEXT,
    );
    expect(
      f.events.some(([name]) => name === "context.compaction.failed"),
    ).toBe(false);
  },
);

test.each(["batch", "slice"] as const)(
  "bound EA completes compaction after steering during its nested %s admission count",
  async (path) => {
    const f = createNestedCompactionFixture(path, "execution.decision");
    const countsAfterSteering = steerDuringCompactionAdmission(f, path);
    await expect(f.run(0)).rejects.toBeInstanceOf(
      ModelStepSteeringSupersededError,
    );
    expect(countsAfterSteering().length).toBeGreaterThan(0);
    assertCompletedGeneration(f, path);
    expect(f.parentCalls()).toEqual([]);
  },
);

test.each(["batch", "slice"] as const)(
  "unbound SUPER resumes with new steering after the %s admission count",
  async (path) => {
    const f = createNestedCompactionFixture(path, "supervisor.decision");
    const countsAfterSteering = steerDuringCompactionAdmission(f, path);
    await expect(f.run()).resolves.toBe("ok");
    expect(countsAfterSteering().length).toBeGreaterThan(0);
    assertCompletedGeneration(f, path);
    expect(f.parentCalls()).toHaveLength(1);
    const messages = f.parentCalls()[0]![0].messages as readonly ChatMessage[];
    expect(JSON.parse(messages.at(-1)!.content)).toMatchObject({
      authority: "user",
      version: 1,
      updates: [{ sequence: 1, text: STEERING_TEXT }],
    });
  },
);

test.each(["batch", "slice"] as const)(
  "unbound Worker keeps its delegated assignment when steering arrives in a %s count",
  async (path) => {
    const f = createNestedCompactionFixture(path, "worker.decision");
    const countsAfterSteering = steerDuringCompactionAdmission(f, path);
    await expect(f.run()).resolves.toBe("ok");
    expect(countsAfterSteering().length).toBeGreaterThan(0);
    expect(f.compactionCalls().length).toBeGreaterThan(1);
    expect(f.store.snapshot!().checkpoints).toHaveLength(1);
    expect(f.parentCalls()).toHaveLength(1);
    expect(JSON.stringify(f.parentCalls()[0]![0].messages)).not.toContain(
      STEERING_TEXT,
    );
  },
);

test("the production EA decision controller finishes every frozen batch before returning to root", async () => {
  const f = await executionCompactionSteeringFixture();
  await f.addResult("second settled source");
  await f.addResult("third settled source");
  const count = f.countInputTokens.getMockImplementation()!;
  f.countInputTokens.mockImplementation(async (input) => {
    const measured = await count(input);
    if (input.modelStep !== "context.compact") return measured;
    const envelope = readCompactionEnvelope(input.messages as ChatMessage[]);
    return {
      ...measured!,
      inputTokens: (envelope.newSources?.length ?? 0) > 1 ? 31_000 : 1_000,
    };
  });
  const invoke = f.invoke.getMockImplementation()!;
  f.invoke.mockImplementation(async (input) => {
    const output = await invoke(input);
    if (input.modelStep === "context.compact")
      f.steering.append({ steerId: "changed", text: STEERING_TEXT });
    return output;
  });

  await expect(f.run()).rejects.toBeInstanceOf(
    ModelStepSteeringSupersededError,
  );
  expect(f.invoke.mock.calls.length).toBeGreaterThan(1);
  expect(f.invoke.mock.calls.every(([input]) => input.modelStep === "context.compact")).toBe(true);
  const visited = f.invoke.mock.calls.flatMap(([input]) =>
    readCompactionEnvelope(input.messages as ChatMessage[]).newSources ?? [],
  );
  expect(visited.every((source) => source.sourceRef)).toBe(true);
  expect(new Set(visited.map(({ sourceRef }) => sourceRef)).size).toBe(visited.length);
  const checkpoints = f.request.contextCompactionStore!.snapshot!().checkpoints;
  expect(checkpoints).toHaveLength(1);
  expect(checkpoints[0]!.sourceDigests.map(({ sourceRef }) => sourceRef))
    .toEqual(visited.map(({ sourceRef }) => sourceRef));
  f.invoke.mockClear();
  await f.run();
  expect(f.invoke).toHaveBeenCalledOnce();
  expect(f.invoke.mock.calls[0]![0].modelStep).toBe("execution.decision");
  expect(f.view().results).toHaveLength(3);
});

function createNestedCompactionFixture(
  path: GenerationPath,
  modelStep: ModelStep,
) {
  const harness = createAdmissionFixture({ modelStep });
  const store = createRequestContextCompactionStore();
  const sliced = path === "slice" || path === "slice_repair";
  const repair = path === "repair" || path === "slice_repair";
  const evidence: ChatMessage[] = Array.from(
    { length: sliced ? 1 : 3 },
    (_, index) => ({
      role: "tool" as const,
      toolCallId: `evidence-${index}`,
      toolName: "observed_result",
      content: `source-${index}: ${"observed fact ".repeat(sliced ? 1_000 : 30)}`,
    }),
  );
  const configuredRequest = {
    ...harness.request,
    runnerConfig: {
      ...harness.request.runnerConfig,
      steps: {
        ...harness.request.runnerConfig.steps,
        "context.compact": { timeoutMs: 20_000 },
      },
    },
  };
  const request = createTestRequestExecutionScope({
    ...configuredRequest,
    sessionId: "nested-compaction-session",
    prompt: "Complete the current assignment.",
    historyMessages: [],
    shouldGenerateSessionTitle: false,
    contextCompactionStore: store,
    workerCapabilityProvider: {
      getDescriptors: () => [],
      getAdapters: () => [],
    },
    toolPermissionMode: "full_access",
    onAcknowledgement: vi.fn(),
    onSessionTitle: vi.fn(async () => undefined),
    onAnswerToken: vi.fn(),
    onEvent: (name, extra) => harness.events.push([name, extra]),
  });
  const controller = createModelStepCompactionController(request, {
    call: {
      roleId: modelStep === "worker.decision" ? "worker" : "supervisor",
      callId: "call-nested-compaction",
      objective: request.prompt,
    },
    consumer: modelStep,
    sourceRevision: 1,
    allowedConsumers: [modelStep],
  });
  const wrapped = {
    ...controller,
    project: (messages: readonly ChatMessage[]) =>
      controller.project([...messages, ...evidence]),
  };
  harness.countInputTokens.mockImplementation(async (input) => {
    const messages = input.messages as readonly ChatMessage[];
    let inputTokens = 1_000;
    if (input.modelStep === "context.compact") {
      const envelope = readCompactionEnvelope(messages);
      inputTokens = generationInputTokens(envelope, sliced);
    } else if (messages.some(({ role }) => role === "tool")) {
      inputTokens = modelStep === "execution.decision" ? 29_000 : 24_000;
    }
    return {
      inputTokens,
      profileId: "test",
      provider: "openai",
      model: "test-model",
      contextWindowTokens: 32_000,
      source: "provider_input_token_count",
    };
  });
  let compactorInvocations = 0;
  const envelopes: CompactionEnvelope[] = [];
  harness.invoke.mockImplementation(async (input) => {
    if (input.modelStep !== "context.compact") return { text: "ok", meta: {} };
    const envelope = readCompactionEnvelope(input.messages as ChatMessage[]);
    envelopes.push(envelope);
    compactorInvocations += 1;
    if (compactorInvocations === 1)
      harness.steering.append({ steerId: "changed", text: STEERING_TEXT });
    return {
      text:
        repair && compactorInvocations === 1
          ? "{}"
          : JSON.stringify({
              continuation: compactContinuation(),
              sourceDigests: semanticCompactionReplacementSlots(
                envelope,
                () => "The observed source fact is retained.",
              ),
            }),
      meta: {},
    };
  });
  const compactionCalls = () =>
    harness.invoke.mock.calls.filter(
      ([input]) => input.modelStep === "context.compact",
    );
  const parentCalls = () =>
    harness.invoke.mock.calls.filter(
      ([input]) => input.modelStep === modelStep,
    );
  return {
    ...harness,
    store,
    evidence,
    envelopes,
    compactionCalls,
    parentCalls,
    run: (boundSteeringVersion?: number) =>
      request.modelSteps.invoke({
        modelStep,
        messages: ADMISSION_MESSAGES,
        timeoutReason: "nested_compaction_test_timeout",
        contextCompaction: wrapped,
        ...(boundSteeringVersion === undefined ? {} : { boundSteeringVersion }),
        accept: (text) => text,
      }),
  };
}

function generationInputTokens(
  envelope: CompactionEnvelope,
  sliced: boolean,
): number {
  if (envelope.kind === "runtime_semantic_compaction_checkpoint_v2")
    return 1_000;
  if (!sliced) return (envelope.newSources?.length ?? 0) > 1 ? 31_000 : 1_000;
  if (!envelope.sourceSlice) return 31_000;
  return envelope.sourceSlice.content.length > 4_000 ? 31_000 : 1_000;
}

function assertCompletedGeneration(
  f: ReturnType<typeof createNestedCompactionFixture>,
  path: GenerationPath,
) {
  expect(f.compactionCalls().length).toBeGreaterThan(1);
  const checkpoints = f.store.snapshot!().checkpoints;
  expect(checkpoints).toHaveLength(1);
  expect(checkpoints[0]!.sourceDigests).toHaveLength(f.evidence.length);
  expect(
    f.store.snapshot!().sources.map(({ content }) => JSON.parse(content)),
  ).toEqual(f.evidence);
  if (path === "slice" || path === "slice_repair") {
    const slice = f.envelopes[0]!.sourceSlice!;
    expect(slice.range.endByteExclusive).toBeLessThan(slice.range.totalBytes);
  } else {
    expect(f.envelopes[0]!.newSources).toHaveLength(1);
  }
  expect(
    f.events.filter(([name]) => /^context\.compaction\.(started|completed|failed)$/u.test(name)),
  ).toEqual([
    ["context.compaction.started", expect.any(Object)],
    [
      "context.compaction.completed",
      expect.objectContaining({ coveredSourceCount: f.evidence.length }),
    ],
  ]);
}

function steerDuringCompactionAdmission(
  f: ReturnType<typeof createNestedCompactionFixture>,
  path: "batch" | "slice",
) {
  const count = f.countInputTokens.getMockImplementation()!;
  let steeringCallCount: number | undefined;
  f.countInputTokens.mockImplementation(async (input) => {
    const measured = await count(input);
    if (input.modelStep !== "context.compact") return measured;
    if (steeringCallCount !== undefined) return measured;
    const envelope = readCompactionEnvelope(input.messages as ChatMessage[]);
    const isSelectedAdmissionBoundary = path === "slice"
      ? envelope.sourceSlice !== undefined
      : (envelope.newSources?.length ?? 0) > 1;
    if (!isSelectedAdmissionBoundary) return measured;
    steeringCallCount = f.countInputTokens.mock.calls.length;
    f.steering.append({ steerId: "changed", text: STEERING_TEXT });
    return measured;
  });
  return () => {
    expect(steeringCallCount).toBeDefined();
    return f.countInputTokens.mock.calls
      .slice(steeringCallCount!)
      .filter(([input]) => input.modelStep === "context.compact");
  };
}
