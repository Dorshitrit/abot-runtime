import { describe, expect, test } from "vitest";

import {
  EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
  type WorkerCapabilityDescriptor,
} from "../orchestration/worker-capabilities/index.js";
import { parseWorkerDecisionOutput } from "../steps/worker-decision/parser.js";

const observationCapability: WorkerCapabilityDescriptor = Object.freeze({
  capabilityId: "characterization.observe",
  summary: "Observe one bounded value.",
  effect: "observation",
  controls: EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
});

describe("Worker decision parser characterization", () => {
  test("preserves non-object envelope rejection", () => {
    expect(parseWorkerDecisionOutput("[]")).toEqual({
      ok: false,
      stage: "json_envelope",
      issues: [
        {
          code: "worker_output_not_object",
          path: "decision",
          message: "Worker decision failed worker_output_not_object.",
        },
      ],
    });
  });

  test("preserves invalid capability identity rejection", () => {
    expect(
      parseWorkerDecisionOutput(
        JSON.stringify({
          decision: {
            action: "invoke_capability",
            capabilityId: 42,
            intent: "Observe the value.",
          },
        }),
        undefined,
        { availableCapabilities: [observationCapability] },
      ),
    ).toMatchObject({
      ok: false,
      stage: "domain_parser",
      issues: [
        {
          code: "worker_capability_id_invalid",
          path: "decision.capabilityId",
        },
      ],
    });
  });

  test("preserves primitive batch item path and issue", () => {
    expect(
      parseWorkerDecisionOutput(
        JSON.stringify({
          decision: {
            action: "invoke_capabilities",
            invocations: [
              null,
              {
                capabilityId: observationCapability.capabilityId,
                intent: "Observe the value.",
              },
            ],
          },
        }),
        undefined,
        {
          availableCapabilities: [observationCapability],
          maxBatchCapabilityExecutions: 2,
        },
      ),
    ).toMatchObject({
      ok: false,
      stage: "domain_parser",
      issues: [
        {
          code: "worker_capability_batch_item_invalid",
          path: "decision.invocations[0]",
        },
      ],
    });
  });

  test("preserves execution controls shape rejection", () => {
    expect(
      parseWorkerDecisionOutput(
        JSON.stringify({
          decision: { action: "invoke_capability", controls: "invalid" },
        }),
        undefined,
        {
          decisionPhase: "capability_execution",
          availableCapabilities: [observationCapability],
          pendingCapabilitySelection: {
            capabilityId: observationCapability.capabilityId,
            intent: "Observe the value.",
          },
        },
      ),
    ).toMatchObject({
      ok: false,
      stage: "domain_parser",
      issues: [
        {
          code: "worker_capability_controls_not_object",
          path: "decision.controls",
        },
      ],
    });
  });

  test("preserves missing single-capability refinement rejection", () => {
    const secondObservationCapability: WorkerCapabilityDescriptor = {
      ...observationCapability,
      capabilityId: "characterization.observe-second",
    };
    expect(
      parseWorkerDecisionOutput(
        JSON.stringify({
          decision: { action: "invoke_capability", controls: {} },
        }),
        undefined,
        {
          decisionPhase: "capability_execution",
          availableCapabilities: [
            observationCapability,
            secondObservationCapability,
          ],
          maxBatchCapabilityExecutions: 2,
          pendingCapabilityBatchSelection: [
            {
              capabilityId: observationCapability.capabilityId,
              intent: "Observe the first value.",
            },
            {
              capabilityId: secondObservationCapability.capabilityId,
              intent: "Observe the second value.",
            },
          ],
        },
      ),
    ).toMatchObject({
      ok: false,
      stage: "domain_parser",
      issues: [
        {
          code: "worker_capability_refinement_invalid",
          path: "decision.action",
        },
      ],
    });
  });

  test("preserves invalid capability controls schema rejection", () => {
    const invalidControlsCapability: WorkerCapabilityDescriptor = {
      ...observationCapability,
      capabilityId: "characterization.invalid-controls",
      selectionControlIds: ["missing"],
    };
    expect(
      parseWorkerDecisionOutput(
        JSON.stringify({
          decision: {
            action: "invoke_capability",
            capabilityId: invalidControlsCapability.capabilityId,
            intent: "Observe the value.",
          },
        }),
        undefined,
        { availableCapabilities: [invalidControlsCapability] },
      ),
    ).toMatchObject({
      ok: false,
      stage: "domain_parser",
      issues: [
        {
          code: "worker_capability_controls_schema_invalid",
          path: "decision.capabilityId",
        },
      ],
    });
  });

  test("preserves pending selection option errors before JSON decoding", () => {
    const pending = {
      capabilityId: observationCapability.capabilityId,
      intent: "Observe the value.",
    };
    expect(() =>
      parseWorkerDecisionOutput("not-json", undefined, {
        availableCapabilities: [observationCapability],
        pendingCapabilitySelection: pending,
      }),
    ).toThrow("worker_pending_capability_selection_unexpected");
    expect(() =>
      parseWorkerDecisionOutput("not-json", undefined, {
        decisionPhase: "capability_execution",
        availableCapabilities: [observationCapability],
      }),
    ).toThrow("worker_pending_capability_selection_invalid");
    expect(() =>
      parseWorkerDecisionOutput("not-json", undefined, {
        decisionPhase: "capability_execution",
        availableCapabilities: [observationCapability],
        maxBatchCapabilityExecutions: 2,
        pendingCapabilityBatchSelection: [pending],
      }),
    ).toThrow("worker_pending_capability_batch_selection_invalid");
  });

  test("preserves issue ordering within one rejected decision", () => {
    expect(
      parseWorkerDecisionOutput(
        JSON.stringify({
          decision: { action: "return_failure", reason: " ", extra: true },
        }),
      ),
    ).toMatchObject({
      ok: false,
      stage: "domain_parser",
      issues: [
        { code: "worker_decision_shape_invalid", path: "decision" },
        { code: "worker_result_invalid", path: "decision.reason" },
      ],
    });
  });
});
