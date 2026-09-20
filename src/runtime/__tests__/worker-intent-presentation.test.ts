import { describe, expect, test } from "vitest";

import {
  EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
  type WorkerCapabilityDescriptor,
} from "../orchestration/worker-capabilities/index.js";
import { parseWorkerDecisionOutput } from "../steps/worker-decision/parser.js";

const observation: WorkerCapabilityDescriptor = {
  capabilityId: "presentation.observe",
  summary: "Observe the assigned target.",
  effect: "observation",
  controls: EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
};
const secondObservation: WorkerCapabilityDescriptor = {
  ...observation,
  capabilityId: "presentation.observe-second",
};
const mutation: WorkerCapabilityDescriptor = {
  ...observation,
  capabilityId: "presentation.mutate",
  effect: "mutation",
  requiresPayloadAuthoringObjective: true,
};
const options = {
  availableCapabilities: [observation, secondObservation, mutation],
  maxBatchCapabilityExecutions: 2,
} as const;

function parse(decision: unknown) {
  return parseWorkerDecisionOutput(
    JSON.stringify({ decision }),
    undefined,
    options,
  );
}

describe("Worker presentation intent normalization", () => {
  test.each([
    ...[1, 500, 510, 750, 1491].map((length) => ({
      label: `${length} characters`,
      intent: "x".repeat(length),
      expected: "x".repeat(Math.min(length, 500)),
    })),
    {
      label: "whitespace at cutoff",
      intent: `${"a".repeat(499)} ${"b".repeat(10)}`,
      expected: "a".repeat(499),
    },
    {
      label: "whitespace before split surrogate",
      intent: `${"a".repeat(498)} 😀tail`,
      expected: "a".repeat(498),
    },
  ])(
    "bounds the description before refinement: $label",
    ({ intent, expected }) => {
      const selected = parse({
        action: "invoke_capability",
        capabilityId: observation.capabilityId,
        intent,
      });
      expect(selected).toEqual({
        ok: true,
        decision: {
          action: "invoke_capability",
          capabilityId: observation.capabilityId,
          intent: expected,
        },
      });
      if (!selected.ok || selected.decision.action !== "invoke_capability") {
        throw new Error("expected accepted selection");
      }
      const refined = parseWorkerDecisionOutput(
        JSON.stringify({
          decision: { action: "invoke_capability", controls: {} },
        }),
        undefined,
        {
          ...options,
          decisionPhase: "capability_execution",
          pendingCapabilitySelection: selected.decision,
        },
      );
      expect(refined).toEqual({
        ok: true,
        decision: { ...selected.decision, controls: {} },
      });
      expect(Object.isFrozen(selected.decision)).toBe(true);
    },
  );

  test("trims display whitespace before bounding and preserves whole Unicode characters", () => {
    expect(
      parse({
        action: "invoke_capability",
        capabilityId: observation.capabilityId,
        intent: `  ${"א".repeat(499)}😀 after the limit  `,
      }),
    ).toMatchObject({ ok: true, decision: { intent: "א".repeat(499) } });
    expect(
      parse({
        action: "invoke_capability",
        capabilityId: observation.capabilityId,
        intent: `${"a".repeat(498)}😀tail`,
      }),
    ).toMatchObject({ ok: true, decision: { intent: `${"a".repeat(498)}😀` } });
  });

  test.each(
    [undefined, null, "", "   ", 42, true, {}, []].map((intent) => ({
      intent,
    })),
  )("still rejects invalid display text $intent", ({ intent }) => {
    expect(
      parse({
        action: "invoke_capability",
        capabilityId: observation.capabilityId,
        intent,
      }),
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "worker_capability_intent_invalid",
          path: "decision.intent",
        }),
      ]),
    });
  });

  test("bounds each batch intent once and preserves its exact refinement slot", () => {
    const selected = parse({
      action: "invoke_capabilities",
      invocations: [
        {
          capabilityId: observation.capabilityId,
          intent: `${"a".repeat(499)} ${"b".repeat(10)}`,
        },
        {
          capabilityId: secondObservation.capabilityId,
          intent: `${"b".repeat(498)} 😀tail`,
        },
      ],
    });
    expect(selected).toEqual({
      ok: true,
      decision: {
        action: "invoke_capabilities",
        invocations: [
          { capabilityId: observation.capabilityId, intent: "a".repeat(499) },
          {
            capabilityId: secondObservation.capabilityId,
            intent: "b".repeat(498),
          },
        ],
      },
    });
    if (!selected.ok || selected.decision.action !== "invoke_capabilities") {
      throw new Error("expected accepted batch selection");
    }
    const refined = parseWorkerDecisionOutput(
      JSON.stringify({
        decision: {
          action: "invoke_capabilities",
          invocations: {
            invocation_1: { controls: {} },
            invocation_2: { controls: {} },
          },
        },
      }),
      undefined,
      {
        ...options,
        decisionPhase: "capability_execution",
        pendingCapabilityBatchSelection: selected.decision.invocations,
      },
    );
    expect(refined).toEqual({
      ok: true,
      decision: {
        action: "invoke_capabilities",
        invocations: selected.decision.invocations.map((invocation) => ({
          ...invocation,
          controls: {},
        })),
      },
    });
  });

  test("preserves payload authority independently of the shortened display text", () => {
    const authoringObjective = "Write the exact authorized content. "
      .repeat(30)
      .trim();
    expect(
      parse({
        action: "invoke_capability",
        capabilityId: mutation.capabilityId,
        intent: "display only ".repeat(100),
        authoringObjective,
      }),
    ).toMatchObject({
      ok: true,
      decision: {
        intent: "display only ".repeat(100).trim().slice(0, 500),
        authoringObjective,
      },
    });
    expect(
      parse({
        action: "invoke_capability",
        capabilityId: mutation.capabilityId,
        intent: "display only ".repeat(100),
        authoringObjective: "x".repeat(8193),
      }),
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "worker_capability_authoring_objective_invalid",
        }),
      ]),
    });
  });

  test.each([
    {
      change: { capabilityId: "missing" },
      issue: "worker_capability_unavailable",
    },
    { change: { controls: {} }, issue: "worker_decision_shape_invalid" },
    { change: { action: "unknown" }, issue: "worker_action_invalid" },
  ])("does not relax $issue", ({ change, issue }) => {
    expect(
      parse({
        action: "invoke_capability",
        capabilityId: observation.capabilityId,
        intent: "x".repeat(510),
        ...change,
      }),
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: issue }),
      ]),
    });
  });

  test("still rejects a mutation in an observation batch", () => {
    expect(
      parse({
        action: "invoke_capabilities",
        invocations: [
          { capabilityId: observation.capabilityId, intent: "x".repeat(510) },
          {
            capabilityId: mutation.capabilityId,
            intent: "x".repeat(510),
            authoringObjective: "Write.",
          },
        ],
      }),
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "worker_capability_batch_effect_invalid",
        }),
      ]),
    });
  });
});
