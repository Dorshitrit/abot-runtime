import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { CapabilityDescriptor } from "../orchestration/capability-adapters/index.js";
import type { WorkerCapabilityAdapter } from "../orchestration/worker-capabilities/index.js";
import type { RequestCapabilityExecutionView } from "../request/execution-scope.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { runRequestRunner } from "../request/runner.js";
import { createControlsEvidenceFixture } from "./support/execution-controls-evidence-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());
const lookup: CapabilityDescriptor = {
  capabilityId: "web.lookup",
  summary: "Find exact URLs.",
  effect: "observation",
  catalogGroups: ["web"],
  controls: {
    type: "object",
    additionalProperties: false,
    properties: {},
    required: [],
  },
};
const fetch: CapabilityDescriptor = {
  capabilityId: "web.fetch",
  summary: "Fetch selected URL.",
  effect: "observation",
  catalogGroups: ["web"],
  controls: {
    type: "object",
    additionalProperties: false,
    properties: { url: { type: "string", minLength: 1 } },
    required: ["url"],
  },
};
const urls = [
  "https://example.test/exact/a?revision=1&encoded=%2F",
  "https://example.test/exact/b#section",
];
const reply = (decision: unknown) => ({
  text: JSON.stringify({ decision }),
  meta: {},
});

test("C5/C8/C20: EA selects guided exact URLs before direct batch dispatch", async () => {
  const observed: string[] = [];
  const sharedGuidance = "EA_BATCH_GUIDANCE_SENTINEL";
  const lookupExecute = vi.fn(async () => ({
    outcome: "succeeded" as const,
    observedEffect: "observation" as const,
    summary: "Located both exact URLs.",
    referenceData: JSON.stringify({ first: urls[0], second: urls[1] }),
  }));
  const fetchExecute = vi.fn<
    WorkerCapabilityAdapter<RequestCapabilityExecutionView>["execute"]
  >(async (input) => {
    expect(input).not.toHaveProperty("controlsEvidenceExecutionIds");
    expect(input.controls).not.toHaveProperty("controlsEvidenceExecutionIds");
    observed.push(input.controls.url as string);
    return {
      outcome: "succeeded",
      observedEffect: "observation",
      summary: `Fetched ${input.controls.url}.`,
    };
  });
  const fixture = await createControlsEvidenceFixture({
    prompt:
      "Look up the two URLs, fetch the first then the second, and report.",
    workerCapabilityProvider: {
      getExecutionGuidance: async (capabilityId) =>
        capabilityId === fetch.capabilityId ? sharedGuidance : "",
      getDescriptors: () => [lookup, fetch],
      getAdapters: () => [
        { descriptor: lookup, execute: lookupExecute },
        { descriptor: fetch, execute: fetchExecute },
      ],
    },
  });
  let decisionCount = 0;
  fixture.invoke.mockImplementation(async (input) => {
    const messages = input.messages as readonly ChatMessage[];
    if (input.modelStep === "execution.response")
      return { text: "Fetched both selected URLs.", meta: {} };
    expect(input.modelStep).toBe("execution.decision");
    decisionCount++;
    if (decisionCount === 1)
      return reply({
        action: "open_capability_scope",
        catalogGroupIds: ["web"],
        acknowledgement: "I will fetch the located pages.",
      });
    if (decisionCount === 2)
      return reply({
        action: "invoke_capability",
        capabilityId: lookup.capabilityId,
        intent: "Locate exact URLs.",
        workingDirectory: null,
      });
    if (decisionCount === 3) {
      const decisionContext = messages.map(({ content }) => content).join("\n");
      expect(decisionContext.split(sharedGuidance)).toHaveLength(2);
      const resultMessages = messages.filter(({ role }) => role === "tool");
      expect(resultMessages).toHaveLength(1);
      const result = JSON.parse(resultMessages[0]!.content);
      expect(result.kind).toBe("runtime_execution_capability_result_v1");
      const exact = JSON.parse(
        result.result.adapterResult.payload.referenceData,
      );
      expect(exact).toEqual({ first: urls[0], second: urls[1] });
      return reply({
        action: "invoke_capabilities",
        invocations: ["first", "second"].map((ordinal) => ({
          capabilityId: fetch.capabilityId,
          intent: `Fetch the ${ordinal} page.`,
          selectionControls: { url: exact[ordinal] },
        })),
      });
    }
    return reply({ action: "respond" });
  });
  await expect(runRequestRunner(fixture.request)).resolves.toMatchObject({
    output: "Fetched both selected URLs.",
  });
  expect(observed).toEqual(urls);
  expect(lookupExecute).toHaveBeenCalledOnce();
  expect(fetchExecute).toHaveBeenCalledTimes(2);
  expect(
    fixture.invoke.mock.calls.map(([input]) => input.modelStep),
  ).not.toContain("capability.controls");
});

test("C16: direct response adds no Controls selection schema, index or evidence", async () => {
  const fixture = await createControlsEvidenceFixture({
    workerCapabilityProvider: {
      getDescriptors: () => [],
      getAdapters: () => [],
    },
  });
  fixture.invoke.mockImplementation(async (input) => {
    expect(JSON.stringify(input.messages)).not.toContain(
      "controlsEvidenceExecutionIds",
    );
    expect(JSON.stringify(input.messages)).not.toContain(
      "eligibleControlsEvidenceExecutionIds",
    );
    expect(JSON.stringify(input.format ?? null)).not.toContain(
      "controlsEvidenceExecutionIds",
    );
    return input.modelStep === "execution.response"
      ? { text: "Four.", meta: {} }
      : reply({ action: "respond", acknowledgement: "I will answer." });
  });
  await expect(runRequestRunner(fixture.request)).resolves.toMatchObject({
    output: "Four.",
  });
  expect(fixture.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
    "execution.decision",
    "execution.response",
  ]);
});
