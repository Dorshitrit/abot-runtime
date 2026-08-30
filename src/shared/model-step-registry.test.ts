import { createRequire } from "node:module";

import { describe, expect, expectTypeOf, test } from "vitest";

import {
  CORE_DECISION_OUTPUT_TOKEN_LIMIT,
  MODEL_INVOCATION_STEP_REGISTRY,
  resolveModelInvocationStep,
  resolveModelStepOutputTokenLimit,
  type ModelStep,
} from "./model-step-registry.js";
import { resolveRuntimeModelRole } from "./model-role-policy.js";
import { isMainModelStep, MODEL_STEPS } from "./model-steps.js";

const require = createRequire(import.meta.url);
const canonicalRegistryData = require("./model-step-registry-data.json") as {
  steps: unknown;
};

describe("model invocation step registry", () => {
  test("keeps the generated registry closed over the canonical JSON source", () => {
    expect(MODEL_INVOCATION_STEP_REGISTRY).toEqual(canonicalRegistryData.steps);
  });

  test("preserves registered ids as a literal ModelStep union", () => {
    expectTypeOf<ModelStep>().toEqualTypeOf<
      (typeof MODEL_STEPS)[keyof typeof MODEL_STEPS]
    >();
    expectTypeOf<string>().not.toEqualTypeOf<ModelStep>();
  });

  test("keeps both request execution policies in the main model scope", () => {
    expect(
      [
        MODEL_STEPS.SUPERVISOR_DECISION,
        MODEL_STEPS.SUPERVISOR_RESPONSE,
        MODEL_STEPS.WORKER_DECISION,
        MODEL_STEPS.WORKER_RESULT,
        MODEL_STEPS.CAPABILITY_CONTROLS,
        MODEL_STEPS.PLANNER_DECISION,
        MODEL_STEPS.PLANNER_GRAPH,
        MODEL_STEPS.REVIEWER_DECISION,
        MODEL_STEPS.DEGRADED_FINALIZATION,
        MODEL_STEPS.EXECUTION_DECISION,
        MODEL_STEPS.EXECUTION_RESPONSE,
        MODEL_STEPS.AUDITOR_DECISION,
      ].every(isMainModelStep),
    ).toBe(true);
    expect(isMainModelStep(MODEL_STEPS.CONTEXT_COMPACTION)).toBe(false);
    expect(isMainModelStep(MODEL_STEPS.TOOL_PAYLOAD_RAW)).toBe(false);
  });

  test("marks only explicit runtime-core decisions with the fixed output policy", () => {
    const coreDecisionSteps = [
      MODEL_STEPS.SUPERVISOR_DECISION,
      MODEL_STEPS.WORKER_DECISION,
      MODEL_STEPS.PLANNER_DECISION,
      MODEL_STEPS.REVIEWER_DECISION,
      MODEL_STEPS.EXECUTION_DECISION,
      MODEL_STEPS.AUDITOR_DECISION,
    ];
    expect(CORE_DECISION_OUTPUT_TOKEN_LIMIT).toBe(2_048);
    expect(
      Object.values(MODEL_INVOCATION_STEP_REGISTRY)
        .filter(
          (definition) =>
            "outputTokenPolicy" in definition &&
            definition.outputTokenPolicy === "core_decision",
        )
        .map((definition) => definition.id),
    ).toEqual(coreDecisionSteps);
    for (const modelStep of coreDecisionSteps) {
      expect(resolveModelInvocationStep(modelStep)).toMatchObject({
        owner: "runtime-core",
        outputTokenPolicy: "core_decision",
      });
      expect(resolveModelStepOutputTokenLimit(modelStep)).toBe(2_048);
    }

    for (const modelStep of [
      MODEL_STEPS.SUPERVISOR_RESPONSE,
      MODEL_STEPS.WORKER_RESULT,
      MODEL_STEPS.CAPABILITY_CONTROLS,
      MODEL_STEPS.PLANNER_GRAPH,
      MODEL_STEPS.DEGRADED_FINALIZATION,
      MODEL_STEPS.EXECUTION_RESPONSE,
      MODEL_STEPS.CONTEXT_COMPACTION,
      MODEL_STEPS.TOOL_PAYLOAD_RAW,
      "unregistered.decision",
    ]) {
      expect(resolveModelStepOutputTokenLimit(modelStep)).toBeUndefined();
    }
  });

  test.each([
    [
      MODEL_STEPS.SUPERVISOR_DECISION,
      "supervisor",
      "json",
      "supervisor_decision",
      "conversation",
    ],
    [
      MODEL_STEPS.SUPERVISOR_RESPONSE,
      "supervisor",
      "raw",
      "supervisor_response",
      "conversation",
    ],
    [
      MODEL_STEPS.PLANNER_DECISION,
      "planner",
      "json",
      "planner_decision",
      "none",
    ],
    [
      MODEL_STEPS.PLANNER_GRAPH,
      "planner",
      "json",
      "planner_graph_proposal",
      "none",
    ],
    [MODEL_STEPS.WORKER_DECISION, "worker", "json", "worker_decision", "none"],
    [MODEL_STEPS.WORKER_RESULT, "worker", "raw", "worker_result", "none"],
    [
      MODEL_STEPS.CAPABILITY_CONTROLS,
      "utility",
      "json",
      "capability_controls",
      "conversation",
    ],
    [
      MODEL_STEPS.REVIEWER_DECISION,
      "reviewer",
      "json",
      "reviewer_decision",
      "none",
    ],
    [
      MODEL_STEPS.EXECUTION_DECISION,
      "executor",
      "json",
      "execution_agent_decision",
      "conversation",
    ],
    [
      MODEL_STEPS.EXECUTION_RESPONSE,
      "utility",
      "raw",
      "execution_response_text",
      "conversation",
    ],
    [
      MODEL_STEPS.AUDITOR_DECISION,
      "auditor",
      "json",
      "auditor_decision",
      "none",
    ],
  ] as const)(
    "registers %s as a generic main role boundary",
    (modelStep, role, defaultFormat, outputContract, attachmentPolicy) => {
      expect(resolveModelInvocationStep(modelStep)).toMatchObject({
        owner: "runtime-core",
        role,
        lane: "main",
        defaultFormat,
        outputContract,
        attachmentPolicy,
      });
    },
  );

  test("keeps degraded finalization and runtime utilities explicit", () => {
    expect(
      resolveModelInvocationStep(MODEL_STEPS.DEGRADED_FINALIZATION),
    ).toMatchObject({
      owner: "runtime-core",
      role: "chatFinalization",
      lane: "main",
      defaultFormat: "json",
      outputContract: "degraded_finalization",
    });
    expect(
      resolveModelInvocationStep(MODEL_STEPS.TOOL_PAYLOAD_RAW),
    ).toMatchObject({
      owner: "runtime-core",
      role: "utility",
      lane: "utility",
      defaultFormat: "raw",
      outputContract: "tool_payload_text",
    });
    expect(
      resolveModelInvocationStep(MODEL_STEPS.CONTEXT_COMPACTION),
    ).toMatchObject({
      owner: "runtime-core",
      role: "utility",
      lane: "utility",
      defaultFormat: "json",
      outputContract: "context_compaction",
    });
  });

  test.each([
    "request.initial_decision",
    "development.planner",
    "development.worker",
    "development.reviewer",
    "general.planner",
    "general.worker",
    "researcher.decision",
  ])("does not register removed legacy step %s", (modelStep) => {
    expect(resolveModelInvocationStep(modelStep)).toBeUndefined();
  });
});

describe("model invocation role policy", () => {
  test.each([
    [MODEL_STEPS.SUPERVISOR_DECISION, "supervisor"],
    [MODEL_STEPS.SUPERVISOR_RESPONSE, "supervisor"],
    [MODEL_STEPS.PLANNER_DECISION, "planner"],
    [MODEL_STEPS.PLANNER_GRAPH, "planner"],
    [MODEL_STEPS.WORKER_DECISION, "worker"],
    [MODEL_STEPS.WORKER_RESULT, "worker"],
    [MODEL_STEPS.CAPABILITY_CONTROLS, "utility"],
    [MODEL_STEPS.REVIEWER_DECISION, "reviewer"],
    [MODEL_STEPS.DEGRADED_FINALIZATION, "chatFinalization"],
    [MODEL_STEPS.EXECUTION_DECISION, "executor"],
    [MODEL_STEPS.EXECUTION_RESPONSE, "utility"],
    [MODEL_STEPS.AUDITOR_DECISION, "auditor"],
  ] as const)("resolves %s to %s", (modelStep, expectedRole) => {
    expect(resolveRuntimeModelRole({ modelStep })).toBe(expectedRole);
  });

  test("keeps empty chat requests and rejects removed step ids", () => {
    expect(resolveRuntimeModelRole({})).toBe("chat");
    expect(
      resolveRuntimeModelRole({ modelStep: "development.planner" }),
    ).toBeUndefined();
  });
});
