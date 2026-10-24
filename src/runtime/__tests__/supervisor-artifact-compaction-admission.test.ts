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
) {
  const invocation = resolveModelInvocation(input);
  return {
    inputTokens:
      fixture.assess(
        modelMessages(input),
        input.format as ModelGatewayJsonSchemaFormat,
      ).estimatedInputTokens + 25,
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

test.each(["supervisor_delegation", "supervisor_working_directory"] as const)(
  "provider-count pressure removes optional paths before semantic compaction in %s",
  async (phase) => {
    const options = {
      methodology: "fixture policy " + "m".repeat(80),
      calibration: "fixture calibration " + "c".repeat(80),
      ...(phase === "supervisor_working_directory"
        ? { objective: "Update the saved summary. " + "א".repeat(7000) }
        : {}),
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
    const contextWindowTokens = Math.ceil((estimated + 10) / 0.7);
    let fixture: ReturnType<typeof createArtifactReadmissionFixture>;
    const countInputTokens = vi.fn<
      NonNullable<ModelGatewayClient["countInputTokens"]>
    >(async (input) => countWithProviderOverhead(fixture, input));
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
    expect(countInputTokens.mock.calls.map(([input]) => modelFormatName(input))).toEqual(
      phase === "supervisor_delegation"
        ? ["supervisor_procedure_gate", phase, phase, "supervisor_working_directory", "supervisor_working_directory"]
        : ["supervisor_procedure_gate", "supervisor_delegation", phase, phase],
    );
    const result = fixture
      .workInputs()
      .find((input) => modelFormatName(input) === phase)!;
    const control = baseline
      .workInputs()
      .find((input) => modelFormatName(input) === phase)!;
    expect(modelMessages(result)).toEqual(modelMessages(control));
    expect(result.format).toEqual(control.format);
    expect(modelMessages(result).filter(isCapabilityBriefMessage)).toEqual(
      modelMessages(control).filter(isCapabilityBriefMessage),
    );
    expect(
      modelMessages(result).filter(({ content }) =>
        content.includes(steeringText),
      ),
    ).toHaveLength(1);
    expect(fixture.workInputs().map(modelFormatName)).toEqual([
      "supervisor_delegation",
      "supervisor_working_directory",
    ]);
    expect(
      fixture.events.filter(({ name }) =>
        name.startsWith("context.compaction."),
      ),
    ).toEqual([]);
    const snapshots = fixture.events.filter(
      ({ name }) => name === "context.window.snapshot",
    );
    expect(snapshots).toHaveLength(3);
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
  expect(countInputTokens).toHaveBeenCalledTimes(3);
  expect(
    fixture.workInputs().map(({ messages, format }) => ({ messages, format })),
  ).toEqual(
    baseline.workInputs().map(({ messages, format }) => ({ messages, format })),
  );
});
