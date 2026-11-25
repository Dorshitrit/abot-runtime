import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ModelGatewayJsonSchemaFormat } from "../../model-gateway/types.js";
import { resolveModelInvocation } from "../../model-gateway/invocation-policy.js";
import { isCapabilityBriefMessage } from "../context/capability-brief.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import {
  createArtifactReadmissionFixture,
  isArtifactMessage,
  modelFormatName,
  modelMessages,
} from "./support/supervisor-artifact-readmission-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

const steeringText = "Keep the requested update in the existing project.";

function countWithProviderOverhead(
  fixture: ReturnType<typeof createArtifactReadmissionFixture>,
  input: Parameters<NonNullable<ModelGatewayClient["countInputTokens"]>>[0],
  overheadTokens = 25,
) {
  const invocation = resolveModelInvocation(input);
  return {
    inputTokens:
      fixture.assess(
        modelMessages(input),
        input.format as ModelGatewayJsonSchemaFormat,
      ).estimatedInputTokens + overheadTokens,
    profileId: invocation.profile.id,
    provider: invocation.profile.provider,
    model: invocation.model,
    contextWindowTokens: invocation.profile.contextWindowTokens,
    source: "provider_input_token_count" as const,
  };
}

function appendSteering(
  fixture: ReturnType<typeof createArtifactReadmissionFixture>,
) {
  expect(
    fixture.steering.append({ steerId: "current-guidance", text: steeringText })
      .ok,
  ).toBe(true);
}

test.each([80, 4_000])(
  "provider-count pressure removes optional paths before semantic compaction in fused routing with %i-character methodology",
  async (methodologyLength) => {
    const phase = "supervisor_fused_routing";
    const options = {
      methodology: "fixture policy " + "m".repeat(methodologyLength),
      calibration: "fixture calibration " + "c".repeat(80),
    };
    const ample = createArtifactReadmissionFixture(options);
    const baseline = createArtifactReadmissionFixture({
      ...options,
      targets: [],
    });
    appendSteering(ample);
    appendSteering(baseline);
    await ample.run();
    const expected = await baseline.run();
    const initial = ample
      .workInputs()
      .find((input) => modelFormatName(input) === phase)!;
    const estimated = ample.assess(
      modelMessages(initial),
      initial.format as ModelGatewayJsonSchemaFormat,
    ).estimatedInputTokens;
    // Admit every phase locally, regardless of their relative prompt lengths.
    const largestEnvelope = Math.max(
      ...ample.inputs().map((input) =>
        ample.assess(
          modelMessages(input),
          input.format as ModelGatewayJsonSchemaFormat,
        ).estimatedInputTokens,
      ),
    );
    const contextWindowTokens = Math.ceil((largestEnvelope + 100) / 0.7);
    const triggerTokens = Math.ceil(contextWindowTokens * 0.7);
    // Use the same provider overhead before and after optional-path removal.
    // Only the selected phase should cross the measured admission threshold.
    const phaseOverheadTokens = triggerTokens - estimated + 25;
    let fixture: ReturnType<typeof createArtifactReadmissionFixture>;
    const countInputTokens = vi.fn<
      NonNullable<ModelGatewayClient["countInputTokens"]>
    >(async (input) =>
      countWithProviderOverhead(
        fixture,
        input,
        modelFormatName(input) === phase ? phaseOverheadTokens : 25,
      ),
    );
    fixture = createArtifactReadmissionFixture({
      ...options,
      contextWindowTokens,
      countInputTokens,
    });
    appendSteering(fixture);
    await expect(fixture.run()).resolves.toEqual(expected);

    const phaseCounts = countInputTokens.mock.calls
      .map(([input]) => input)
      .filter((input) => modelFormatName(input) === phase);
    expect(phaseCounts).toHaveLength(2);
    expect(
      modelMessages(phaseCounts[0]!).filter(isArtifactMessage),
    ).toHaveLength(1);
    expect(modelMessages(phaseCounts[1]!).filter(isArtifactMessage)).toEqual(
      [],
    );
    expect(fixture.assess(
      modelMessages(phaseCounts[0]!),
      phaseCounts[0]!.format as ModelGatewayJsonSchemaFormat,
    ).estimatedInputTokens).toBeLessThan(triggerTokens);
    const phaseMeasurements = await Promise.all(
      countInputTokens.mock.results
        .filter((_, index) =>
          modelFormatName(countInputTokens.mock.calls[index]![0]) === phase,
        )
        .map(({ value }) => value),
    );
    expect(phaseMeasurements[0]!.inputTokens).toBeGreaterThan(triggerTokens);
    expect(phaseMeasurements[1]!.inputTokens).toBeLessThan(triggerTokens);
    expect(countInputTokens.mock.calls.map(([input]) => modelFormatName(input)))
      .toEqual(["supervisor_fused_entry", phase, phase]);
    const result = fixture
      .workInputs()
      .find((input) => modelFormatName(input) === phase)!;
    const control = baseline
      .workInputs()
      .find((input) => modelFormatName(input) === phase)!;
    expect(modelMessages(result).filter(message => !isCapabilityBriefMessage(message)))
      .toEqual(modelMessages(control).filter(message => !isCapabilityBriefMessage(message)));
    expect(result.format).toEqual(control.format);
    expect(modelMessages(result).filter(isCapabilityBriefMessage)).toEqual([]);
    expect(
      modelMessages(result).filter(({ content }) =>
        content.includes(steeringText),
      ),
    ).toHaveLength(1);
    expect(fixture.workInputs().map(modelFormatName)).toEqual([
      "supervisor_fused_routing",
    ]);
    expect(
      fixture.events.filter(({ name }) =>
        name.startsWith("context.compaction."),
      ),
    ).toEqual([]);
    const snapshots = fixture.events.filter(
      ({ name }) => name === "context.window.snapshot",
    );
    expect(snapshots).toHaveLength(2);
    for (const { extra } of snapshots) {
      expect(extra?.measuredInputTokens).toBeLessThan(
        Number(extra?.compactionTriggerInputTokens),
      );
    }
  },
);

test("provider counting without artifact state keeps the ordinary two-phase request unchanged", async () => {
  const baseline = createArtifactReadmissionFixture({ targets: [] });
  const expected = await baseline.run();
  let fixture: ReturnType<typeof createArtifactReadmissionFixture>;
  const countInputTokens = vi.fn<
    NonNullable<ModelGatewayClient["countInputTokens"]>
  >(async (input) => countWithProviderOverhead(fixture, input));
  fixture = createArtifactReadmissionFixture({ targets: [], countInputTokens });
  await expect(fixture.run()).resolves.toEqual(expected);
  expect(countInputTokens).toHaveBeenCalledTimes(2);
  expect(
    fixture.workInputs().map(({ messages, format }) => ({ messages, format })),
  ).toEqual(
    baseline.workInputs().map(({ messages, format }) => ({ messages, format })),
  );
});
