import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { isCapabilityBriefMessage } from "../context/capability-brief.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import {
  ARTIFACT_TARGET,
  createArtifactReadmissionFixture,
  isArtifactMessage,
  modelFormatName,
  modelMessages,
  type ArtifactModelInput,
} from "./support/supervisor-artifact-readmission-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

function phaseInputs(
  inputs: readonly ArtifactModelInput[],
  phase: "routing" | "directory",
) {
  const name =
    phase === "routing"
      ? "supervisor_decision"
      : "supervisor_working_directory";
  return inputs.filter((input) => modelFormatName(input) === name);
}

function assertExactArtifact(input: ArtifactModelInput) {
  const capsules = modelMessages(input).filter(isArtifactMessage);
  expect(capsules).toHaveLength(1);
  expect(JSON.parse(capsules[0]!.content).targets).toEqual([ARTIFACT_TARGET]);
}

function assertNoCompaction(
  fixture: ReturnType<typeof createArtifactReadmissionFixture>,
) {
  expect(
    fixture.events.filter(({ name }) => name.startsWith("context.compaction.")),
  ).toEqual([]);
  const snapshots = fixture.events.filter(
    ({ name }) => name === "context.window.snapshot",
  );
  expect(snapshots).toHaveLength(fixture.inputs().length);
  for (const { extra } of snapshots) {
    expect(extra?.estimatedInputTokens).toBeLessThan(
      Number(extra?.compactionTriggerInputTokens),
    );
  }
}

describe("Supervisor artifact paths across actual model attempt admission", () => {
  test.each(["routing", "directory"] as const)(
    "drops optional paths before %s repair without consuming absent compaction sources",
    async (repairPhase) => {
      const options = {
        repairPhase,
        methodology: "fixture method " + "m".repeat(100),
        calibration: "fixture calibration " + "c".repeat(100),
        ...(repairPhase === "directory"
          ? { objective: "Update the saved summary. " + "א".repeat(7000) }
          : {}),
      };
      const ample = createArtifactReadmissionFixture(options);
      const baseline = createArtifactReadmissionFixture({
        ...options,
        targets: [],
      });
      const expected = await baseline.run();
      await ample.run();
      const original = phaseInputs(ample.inputs(), repairPhase);
      const mandatory = phaseInputs(baseline.inputs(), repairPhase);
      const firstRouting = ample.inputs()[0]!;
      const targetTokens =
        Math.max(
          ample.assess(
            modelMessages(firstRouting),
            firstRouting.format as typeof ample.input.format,
          ).estimatedInputTokens,
          ample.assess(
            modelMessages(original[0]!),
            original[0]!.format as typeof ample.input.format,
          ).estimatedInputTokens,
          baseline.assess(
            modelMessages(mandatory[1]!),
            mandatory[1]!.format as typeof baseline.input.format,
          ).estimatedInputTokens,
        ) + 10;
      const contextWindowTokens = Math.ceil(targetTokens / 0.7);
      const fixture = createArtifactReadmissionFixture({
        ...options,
        contextWindowTokens,
      });
      await expect(fixture.run()).resolves.toEqual(expected);
      const attempts = phaseInputs(fixture.inputs(), repairPhase);
      expect(attempts).toHaveLength(2);
      assertExactArtifact(attempts[0]!);
      expect(modelMessages(attempts[1]!).filter(isArtifactMessage)).toEqual([]);
      // Removing the reference also restores its owning instructions, while
      // retaining the exact mandatory context, schema and repair message.
      expect(modelMessages(attempts[1]!)).toEqual(modelMessages(mandatory[1]!));
      expect(attempts[1]!.format).toEqual(mandatory[1]!.format);
      expect(fixture.inputs()).toHaveLength(3);
      expect(
        modelMessages(fixture.inputs()[0]!).filter(isCapabilityBriefMessage),
      ).toEqual(
        modelMessages(baseline.inputs()[0]!).filter(isCapabilityBriefMessage),
      );
      assertNoCompaction(fixture);
    },
  );

  test("retains one exact target in both phases and repair while headroom remains", async () => {
    const fixture = createArtifactReadmissionFixture({
      repairPhase: "routing",
    });
    await fixture.run();
    expect(fixture.inputs()).toHaveLength(3);
    for (const input of fixture.inputs()) assertExactArtifact(input);
    expect(fixture.inputs().map(modelFormatName)).toEqual([
      "supervisor_decision",
      "supervisor_decision",
      "supervisor_working_directory",
    ]);
    assertNoCompaction(fixture);
  });

  test("new steering evicts the optional reference before the next provider attempt", async () => {
    async function rerunAfterSteering(fixture: ReturnType<typeof createArtifactReadmissionFixture>) {
      await expect(fixture.run()).rejects.toMatchObject({ name: "ModelStepSteeringSupersededError" });
      return fixture.run();
    }
    const options = {
      steeringText: "Keep the exact requested outcome. " + "s".repeat(200),
    };
    const ample = createArtifactReadmissionFixture(options);
    const baseline = createArtifactReadmissionFixture({
      ...options,
      targets: [],
    });
    const expected = await rerunAfterSteering(baseline);
    await rerunAfterSteering(ample);
    const mandatory = phaseInputs(baseline.inputs(), "routing");
    const targetTokens =
      Math.max(
        ample.assess(modelMessages(ample.inputs()[0]!)).estimatedInputTokens,
        baseline.assess(modelMessages(mandatory[1]!)).estimatedInputTokens,
      ) + 10;
    const fixture = createArtifactReadmissionFixture({
      ...options,
      contextWindowTokens: Math.ceil(targetTokens / 0.7),
    });
    await expect(rerunAfterSteering(fixture)).resolves.toEqual(expected);
    const routing = phaseInputs(fixture.inputs(), "routing");
    expect(routing).toHaveLength(2);
    assertExactArtifact(routing[0]!);
    expect(modelMessages(routing[1]!)).toEqual(modelMessages(mandatory[1]!));
    for (const input of fixture.inputs().slice(1)) {
      expect(
        modelMessages(input).filter(({ content }) =>
          content.includes(options.steeringText),
        ),
      ).toHaveLength(1);
    }
    expect(expected.steeringVersion).toBe(1);
    expect(fixture.inputs()).toHaveLength(3);
    assertNoCompaction(fixture);
  });

  test("methodology and calibration retain their original placement without duplication on repair", async () => {
    const methodology = "fixture methodology " + "m".repeat(100);
    const calibration = "fixture calibration " + "c".repeat(100);
    const options = {
      repairPhase: "routing" as const,
      methodology,
      calibration,
    };
    const fixture = createArtifactReadmissionFixture(options);
    const baseline = createArtifactReadmissionFixture({
      ...options,
      targets: [],
    });
    await fixture.run();
    await baseline.run();
    for (const [index, input] of fixture.inputs().entries()) {
      const messages = modelMessages(input);
      expect(
        messages.filter(({ content }) => content.includes(methodology)),
      ).toHaveLength(1);
      const projection = fixture.input.artifactPathsProjection!;
      const restored = messages
        .filter((message) => !isArtifactMessage(message))
        .map((message) => ({
          ...message,
          content: message.content.replace(
            projection.instructions,
            projection.baseInstructions,
          ),
        }));
      expect(restored).toEqual(modelMessages(baseline.inputs()[index]!));
    }
    assertNoCompaction(fixture);
  });
});
