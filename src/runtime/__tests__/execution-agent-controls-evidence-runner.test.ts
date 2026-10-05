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
import {
  createControlsEvidenceFixture,
  runtimeCapsule,
} from "./support/execution-controls-evidence-fixture.js";

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

test("C5/C8/C20: selected URLs survive batch Controls through kernel and adapters without evidence fields", async () => {
  const observed: string[] = [];
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
    if (input.modelStep === "capability.controls") {
      const assignment = runtimeCapsule(
        messages,
        "runtime_execution_capability_refinement_v1",
      )!;
      expect(assignment.invocations).toMatchObject([
        {
          slot: "invocation_1",
          capabilityId: fetch.capabilityId,
          controlsEvidenceExecutionIds: ["capability-execution-1"],
          operationObjective: "Fetch only the first located URL.",
        },
        {
          slot: "invocation_2",
          capabilityId: fetch.capabilityId,
          controlsEvidenceExecutionIds: ["capability-execution-1"],
          operationObjective: "Fetch only the second located URL.",
        },
      ]);
      const capsule = runtimeCapsule(
        messages,
        "runtime_request_tool_results_v1",
      )!;
      const results = capsule.results as {
        executionId: string;
        adapterResult: { payload: { referenceData: string } };
      }[];
      expect(results).toHaveLength(1);
      const exact = JSON.parse(results[0]!.adapterResult.payload.referenceData);
      expect(exact).toEqual({ first: urls[0], second: urls[1] });
      return reply({
        invocations: {
          invocation_1: {
            disposition: "execute",
            controls: { url: exact.first },
          },
          invocation_2: {
            disposition: "execute",
            controls: { url: exact.second },
          },
        },
      });
    }
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
    if (decisionCount === 3)
      return reply({
        action: "invoke_capabilities",
        invocations: ["first", "second"].map((ordinal) => ({
          capabilityId: fetch.capabilityId,
          intent: `Fetch the ${ordinal} page.`,
          operationObjective: `Fetch only the ${ordinal} located URL.`,
          controlsEvidenceExecutionIds: ["capability-execution-1"],
        })),
      });
    return reply({ action: "respond" });
  });
  await expect(runRequestRunner(fixture.request)).resolves.toMatchObject({
    output: "Fetched both selected URLs.",
  });
  expect(observed).toEqual(urls);
  expect(lookupExecute).toHaveBeenCalledOnce();
  expect(fetchExecute).toHaveBeenCalledTimes(2);
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
