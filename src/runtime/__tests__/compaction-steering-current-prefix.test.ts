import { afterEach, beforeEach, expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { createSemanticCompactionSha256Fingerprint as hash } from "../context/semantic-compaction/contracts.js";
import { createPolicyModelStepCompactionController } from "../context/super-compaction/routing.js";
import { projectSuperCompactionConfiguration } from "../context/super-compaction/configuration.js";
import { ModelStepSteeringSupersededError } from "../model/model-step-steering.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { REQUEST_STEERING_MESSAGE_KIND } from "../request/request-steering.js";
import { ADMISSION_MESSAGES, createAdmissionFixture } from "./support/compaction-admission-fixture.js";
import {
  executionCompactionSteeringFixture,
  STEERED_CONTINUATION,
  STEERED_FACT,
} from "./support/execution-compaction-steering-fixture.js";
import { createTestRequestExecutionScope, deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";

const UPDATE_A = { steerId: "accepted-a", text: "FIRST_ACCEPTED_DIRECTION" };
const UPDATE_B = { steerId: "pending-b", text: "SECOND_PENDING_DIRECTION" };

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(resetDebugLoggerConfig);

test.each([false, true])(
  "EA response=%s keeps the frozen checkpoint and rebuilds one ordered current STEER capsule",
  async (response) => {
    const f = await executionCompactionSteeringFixture();
    f.steering.append(UPDATE_A);
    const frozen = f.options();
    const invoke = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(async (input) => {
      const result = await invoke(input);
      if (input.modelStep === "context.compact") f.steering.append(UPDATE_B);
      return result;
    });

    await expect(f.run(response, frozen)).rejects.toBeInstanceOf(ModelStepSteeringSupersededError);
    expect(f.invoke.mock.calls.every(([input]) => input.modelStep === "context.compact")).toBe(true);
    const store = f.request.contextCompactionStore!;
    const checkpoint = store.findByCallIds(["call-1"])[0]!;
    expect(checkpoint.objectiveFingerprint).toBe(hash([f.request.prompt, UPDATE_A.text].join("\n")));
    for (const [input] of f.invoke.mock.calls) {
      expect(JSON.stringify(input.messages)).toContain(UPDATE_A.text);
      expect(JSON.stringify(input.messages)).not.toContain(UPDATE_B.text);
    }
    for (const source of store.snapshot!().sources) {
      expect(source.content).not.toContain(UPDATE_A.text);
      expect(source.content).not.toContain(UPDATE_B.text);
    }

    f.invoke.mockClear();
    await f.run(response);
    expect(f.invoke).toHaveBeenCalledOnce();
    const messages = f.invoke.mock.calls[0]![0].messages as readonly ChatMessage[];
    assertCurrentSteeringCapsule(messages);
    expect(JSON.stringify(messages)).toContain(STEERED_FACT);
    expect(JSON.stringify(messages)).not.toContain(STEERED_CONTINUATION);
    expect(store.findByCallIds(["call-1"])).toEqual([checkpoint]);
    expect(store.findByCallIds(["call-1"])[0]).toBe(checkpoint);
  },
);

test("SUPER finishes extraction and lossless joins before applying pending steering once", async () => {
  const f = createSuperFixture();
  expect(f.request.executionPolicy.authority.id).toBe("supervisor-worker-v1");
  await expect(f.run()).resolves.toBe("accepted");
  expect(f.compactionSteps()).toContain("super.compact.coverage");
  expect(f.compactionSteps()).toContain("super.compact.content");
  expect(f.compactionSteps()).not.toContain("super.compact.merge");
  expect(f.compactionSteps()).toContain("super.compact.continuation");
  const checkpoints = f.request.contextCompactionStore!.snapshot!().checkpoints;
  expect(checkpoints).toHaveLength(1);
  expect(checkpoints[0]!.objectiveFingerprint).toBe(hash(f.objective));
  expect(checkpoints[0]!.sourceDigests).toHaveLength(1);
  const sources = f.request.contextCompactionStore!.snapshot!().sources;
  expect(sources).toHaveLength(1);
  expect(sources[0]!.content).toContain("FROZEN_SUPER_SOURCE");
  expect(sources[0]!.content).not.toContain(UPDATE_A.text);
  expect(sources[0]!.content).not.toContain(UPDATE_B.text);
  for (const [input] of f.invoke.mock.calls.filter(([input]) => input.modelStep!.startsWith("super.compact."))) {
    expect(JSON.stringify(input.messages)).not.toContain(UPDATE_B.text);
  }
  const parents = f.invoke.mock.calls.filter(([input]) => input.modelStep === "supervisor.decision");
  expect(parents).toHaveLength(1);
  assertCurrentSteeringCapsule(parents[0]![0].messages as readonly ChatMessage[]);
  expect(f.events.filter(([name]) => /^context\.compaction\.(started|completed|failed)$/u.test(name)).map(([name]) => name))
    .toEqual(["context.compaction.started", "context.compaction.completed"]);
});

test("Stop still interrupts the real SUPER pipeline before later stages or checkpoint commit", async () => {
  const f = createSuperFixture(true);
  await expect(f.run()).rejects.toBe(f.cancellation);
  expect(f.compactionSteps()).toEqual(["super.compact.coverage"]);
  expect(f.request.contextCompactionStore!.snapshot!().checkpoints).toEqual([]);
  expect(f.invoke.mock.calls.some(([input]) => input.modelStep === "supervisor.decision")).toBe(false);
  expect(f.events.filter(([name]) => /^context\.compaction\.(started|completed|failed)$/u.test(name)).map(([name]) => name))
    .toEqual(["context.compaction.started", "context.compaction.failed"]);
});

function assertCurrentSteeringCapsule(messages: readonly ChatMessage[]) {
  const capsules = messages.flatMap((message) => {
    try {
      const value = JSON.parse(message.content);
      return value.kind === REQUEST_STEERING_MESSAGE_KIND ? [{ role: message.role, value }] : [];
    } catch {
      return [];
    }
  });
  expect(capsules).toEqual([{
    role: "user",
    value: expect.objectContaining({
      authority: "user",
      version: 2,
      updates: [
        { sequence: 1, text: UPDATE_A.text },
        { sequence: 2, text: UPDATE_B.text },
      ],
    }),
  }]);
}

function createSuperFixture(cancel = false) {
  const h = createAdmissionFixture({ modelStep: "supervisor.decision" });
  h.steering.append(UPDATE_A);
  const cancellation = new Error("cancelled_during_super_compaction");
  const original = createTestRequestExecutionScope({
    ...h.request,
    runnerConfig: {
      ...h.request.runnerConfig,
      steps: { ...h.request.runnerConfig.steps, "context.compact": { timeoutMs: 20_000 } },
    },
    sessionId: "super-steering-session",
    prompt: "Preserve the original source.",
    historyMessages: [],
    shouldGenerateSessionTitle: false,
    workerCapabilityProvider: { getDescriptors: () => [], getAdapters: () => [] },
    toolPermissionMode: "full_access",
    onAcknowledgement: () => {},
    onSessionTitle: async () => undefined,
    onAnswerToken: () => {},
    onEvent: (name, extra) => h.events.push([name, extra]),
  });
  const request = deriveTestRequestExecutionScope(
    original,
    projectSuperCompactionConfiguration(original, original.executionPolicy.authority),
  );
  const objective = request.prompt;
  const evidence: ChatMessage = {
    role: "tool",
    toolCallId: "frozen-super-evidence",
    toolName: "observed_result",
    content: "FROZEN_SUPER_SOURCE " + "observed evidence ".repeat(1_200),
  };
  const controller = createPolicyModelStepCompactionController(request, {
    call: { roleId: "supervisor", callId: "super-frozen-call", objective },
    consumer: "supervisor.decision",
    sourceRevision: 1,
    allowedConsumers: ["supervisor.decision"],
  }, request.executionPolicy.authority);
  const count = h.countInputTokens.getMockImplementation()!;
  h.countInputTokens.mockImplementation(async (input) => ({
    ...(await count(input))!,
    inputTokens: input.modelStep === "supervisor.decision" &&
      (input.messages as readonly ChatMessage[]).some(({ role }) => role === "tool")
      ? 24_000 : 1_000,
  }));
  h.invoke.mockImplementation(async (input) => {
    if (input.modelStep === "supervisor.decision") return { text: "accepted", meta: {} };
    h.steering.append(UPDATE_B);
    if (cancel) h.abort.abort(cancellation);
    return { text: "Frozen source observation retained.", meta: {} };
  });
  return {
    ...h,
    request,
    objective,
    cancellation,
    compactionSteps: () => h.invoke.mock.calls
      .map(([input]) => input.modelStep!)
      .filter((step) => step.startsWith("super.compact.")),
    run: () => request.modelSteps.invoke({
      modelStep: "supervisor.decision",
      messages: ADMISSION_MESSAGES,
      timeoutReason: "super_steering_test_timeout",
      contextCompaction: {
        ...controller,
        project: (messages) => controller.project([...messages, evidence]),
      },
      accept: (text) => text,
    }),
  };
}
