import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resolveModelInvocation } from "../../model-gateway/invocation-policy.js";
import { invokeModelStep } from "../model/invoke-step.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import { createSupervisorArtifactPathsOptionalProjection } from "../steps/supervisor-decision/artifact-paths.js";
import {
  createArtifactReadmissionFixture, isArtifactMessage, modelFormatName, modelMessages,
} from "./support/supervisor-artifact-readmission-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

const historyMessages = [
  { id: "source-user", role: "user" as const, content: "Summarize this source exactly.", createdAt: "2026-10-20T00:00:00.000Z", requestId: "source-request" },
  { id: "source-assistant", role: "assistant" as const, content: "EXACT_SOURCE_BODY: unicode אבג and original wording.", createdAt: "2026-10-20T00:00:01.000Z", requestId: "source-request" },
];

type Phase = "supervisor_delegation" | "supervisor_working_directory";
function fixture(phase: Phase, mandatoryFits = true) {
  const countInputTokens = vi.fn<NonNullable<ModelGatewayClient["countInputTokens"]>>(async (input) => {
    const invocation = resolveModelInvocation(input);
    const pressured = modelFormatName(input) === phase;
    const optional = modelMessages(input).some(isArtifactMessage);
    return {
      inputTokens: pressured ? (optional || !mandatoryFits ? 40_001 : 31_000) : 1000,
      profileId: invocation.profile.id, provider: invocation.profile.provider,
      model: invocation.model, contextWindowTokens: invocation.profile.contextWindowTokens,
      source: "provider_input_token_count",
    };
  });
  return { ...createArtifactReadmissionFixture({ contextWindowTokens: 40_000, historyMessages, countInputTokens }), countInputTokens };
}

test.each(["supervisor_delegation", "supervisor_working_directory"] as const)(
  "%s drops optional paths on measured hard overflow, preserving exact mandatory source above the compaction trigger", async (phase) => {
    const f = fixture(phase);
    const before = f.request.contextCompactionStore?.snapshot?.();
    await expect(f.run()).resolves.toMatchObject({ decision: { action: "invoke_role", workingDirectory: ".exact-artifacts" } });
    const counted = f.countInputTokens.mock.calls.map(([input]) => input).filter((input) => modelFormatName(input) === phase);
    expect(counted).toHaveLength(2);
    expect(modelMessages(counted[0]!).filter(isArtifactMessage)).toHaveLength(1);
    expect(modelMessages(counted[1]!).filter(isArtifactMessage)).toEqual([]);
    const dispatched = f.inputs().find((input) => modelFormatName(input) === phase)!;
    for (const message of historyMessages)
      expect(modelMessages(dispatched)).toContainEqual({ role: message.role, content: message.content });
    expect(modelMessages(dispatched)).toContainEqual({ role: "user", content: f.request.prompt });
    expect(modelMessages(dispatched).filter(isArtifactMessage)).toEqual([]);
    expect(f.events.filter(({ name }) => name.startsWith("context.compaction."))).toEqual([]);
    expect(f.request.contextCompactionStore?.snapshot?.()).toEqual(before);
    expect(f.request.modelGatewayClient.invokeRaw).not.toHaveBeenCalled();
    expect(f.events.filter(({ name }) => name === "context.window.snapshot").map(({ extra }) => extra))
      .toContainEqual(expect.objectContaining({ measuredInputTokens: 31_000, admissionOutcome: "accepted", compactionTriggerEligible: false }));
  },
);

test.each(["supervisor_delegation", "supervisor_working_directory"] as const)(
  "%s still rejects mandatory hard overflow after optional omission", async (phase) => {
    const f = fixture(phase, false);
    await expect(f.run()).rejects.toThrow("request_context_final_envelope_exceeds_window");
    expect(f.inputs().filter((input) => modelFormatName(input) === phase)).toEqual([]);
    const counted = f.countInputTokens.mock.calls.map(([input]) => input).filter((input) => modelFormatName(input) === phase);
    expect(counted).toHaveLength(2);
    expect(modelMessages(counted[1]!).filter(isArtifactMessage)).toEqual([]);
    expect(f.events.filter(({ name }) => name.startsWith("context.compaction."))).toEqual([]);
    expect(f.request.modelGatewayClient.invokeRaw).not.toHaveBeenCalled();
  },
);

test("exact retention never consults semantic controllers; only the explicit optional hook can remove its bound reference", async () => {
  const f = fixture("supervisor_delegation");
  const controller = {
    project: vi.fn(() => { throw new Error("semantic_projection_forbidden"); }),
    projectForCompaction: vi.fn(() => { throw new Error("semantic_omission_forbidden"); }),
    getStages: vi.fn(() => { throw new Error("semantic_stages_forbidden"); }),
    hasExhaustedVerifiedCompactionSources: vi.fn(() => { throw new Error("exhaustion_forbidden"); }),
  };
  const input = {
    request: f.request, modelStep: "supervisor.decision" as const,
    messages: f.input.context.messages, format: f.input.format,
    contextRetention: "exact" as const, contextCompaction: controller,
    timeoutReason: "fixture_timeout", accept: () => "accepted",
  };
  await expect(invokeModelStep(input)).rejects.toThrow("request_context_final_envelope_exceeds_window");
  expect(f.invoke).not.toHaveBeenCalled();
  await expect(invokeModelStep({ ...input, optionalContextProjection: createSupervisorArtifactPathsOptionalProjection({
    projection: f.input.artifactPathsProjection, includeInstructions: true,
  }) })).resolves.toBe("accepted");
  for (const callback of Object.values(controller)) expect(callback).not.toHaveBeenCalled();
  expect(f.countInputTokens).toHaveBeenCalledTimes(3);
  expect(f.invoke).toHaveBeenCalledOnce();
});
