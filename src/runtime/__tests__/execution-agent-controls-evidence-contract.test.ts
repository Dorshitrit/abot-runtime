import { describe, expect, test } from "vitest";
import type { CapabilityDescriptor } from "../orchestration/capability-adapters/index.js";
import {
  createExecutionAgentDecisionFormat,
  parseExecutionAgentDecisionOutput,
} from "../steps/execution-agent/index.js";

const path = { type: "string", minLength: 1, maxLength: 4096 } as const;
const complete = {
  capabilityId: "author_complete",
  summary: "Author using already selected controls.",
  effect: "observation",
  controls: {
    type: "object",
    additionalProperties: false,
    properties: { path },
    required: ["path"],
  },
  selectionControlIds: ["path"],
  requiresPayloadAuthoringObjective: true,
} as const satisfies CapabilityDescriptor;
const remaining = {
  summary: "Author an inspection using a query grounded in exact evidence.",
  effect: complete.effect,
  requiresPayloadAuthoringObjective: true,
  selectionControlIds: complete.selectionControlIds,
  capabilityId: "author_remaining",
  controls: {
    ...complete.controls,
    properties: { path, query: path },
    required: ["path", "query"],
  },
} as const satisfies CapabilityDescriptor;
const evidence = Object.freeze(["execution-first", "execution-second"]);

function selection(capabilityId: string = remaining.capabilityId) {
  return {
    capabilityId,
    operationObjective: "Complete the bounded operation on exact.txt.",
    selectionControls: { path: "exact.txt" },
  };
}

function contract(
  capabilities: readonly CapabilityDescriptor[] = [complete, remaining],
) {
  return {
    capabilities,
    maxBatchCapabilityExecutions: 2,
    eligibleControlsEvidenceExecutionIds: evidence,
  };
}

function parse(
  decision: object,
  capabilities?: readonly CapabilityDescriptor[],
) {
  return parseExecutionAgentDecisionOutput(
    JSON.stringify({ decision }),
    contract(capabilities),
  );
}

type Schema = {
  properties?: Record<string, Schema>;
  required?: string[];
  enum?: string[];
  anyOf?: Schema[];
  items?: Schema;
  maxItems?: number;
};

function variants(schema: Schema): Schema[] {
  return schema.anyOf ?? [schema];
}

describe("EA selected Controls evidence contract", () => {
  test.each([
    [complete, remaining],
    [remaining, complete],
  ])(
    "C19: separates field requirements in compiled single and batch schemas",
    (...capabilities) => {
      const schema = createExecutionAgentDecisionFormat(contract(capabilities))
        .schema as Schema;
      const decisions = variants(schema.properties!.decision!);
      const singles = decisions.filter((entry) =>
        entry.properties!.action!.enum!.includes("invoke_capability"),
      );
      const batch = decisions.find((entry) =>
        entry.properties!.action!.enum!.includes("invoke_capabilities"),
      )!;
      const batchItems = variants(batch.properties!.invocations!.items!);
      for (const candidates of [singles, batchItems]) {
        const completeSchema = candidates.find((entry) =>
          entry.properties!.capabilityId!.enum!.includes(complete.capabilityId),
        )!;
        const remainingSchema = candidates.find((entry) =>
          entry.properties!.capabilityId!.enum!.includes(
            remaining.capabilityId,
          ),
        )!;
        expect(completeSchema.properties).not.toHaveProperty(
          "controlsEvidenceExecutionIds",
        );
        expect(remainingSchema.required).toContain(
          "controlsEvidenceExecutionIds",
        );
        expect(
          remainingSchema.properties!.controlsEvidenceExecutionIds,
        ).toMatchObject({ type: "array", minItems: 0, maxItems: 2 });
      }
    },
  );

  test.each(
    [[], [evidence[1]], [evidence[1], evidence[0]]].map((ids) => ({ ids })),
  )("C3: accepts explicit valid selection $ids", ({ ids }) => {
    expect(
      parse({
        action: "invoke_capability",
        ...selection(),
        controlsEvidenceExecutionIds: ids,
      }),
    ).toMatchObject({
      ok: true,
      decision: { controlsEvidenceExecutionIds: ids },
    });
  });

  test.each(
    [
      undefined,
      null,
      "execution-first",
      [""],
      ["unknown"],
      ["foreign-call"],
      ["running-execution"],
      ["memory-recall"],
      ["result-1"],
      ["https://example.test"],
      [evidence[0], evidence[0]],
      [evidence[0], evidence[1], "third"],
      [1],
    ].map((ids) => ({ ids })),
  )("C3: rejects invalid or absent selection $ids", ({ ids }) => {
    const result = parse({
      action: "invoke_capability",
      ...selection(),
      ...(ids === undefined ? {} : { controlsEvidenceExecutionIds: ids }),
    });
    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "decision.controlsEvidenceExecutionIds",
        }),
      ]),
    });
  });

  test("C13: forbids evidence field on fully materialized payload guidance", () => {
    expect(
      parse({
        action: "invoke_capability",
        ...selection(complete.capabilityId),
      }),
    ).toMatchObject({ ok: true });
    expect(
      parse({
        action: "invoke_capability",
        ...selection(complete.capabilityId),
        controlsEvidenceExecutionIds: [],
      }),
    ).toMatchObject({ ok: false });
  });

  test("C19: batch parser applies each invocation's own requirement", () => {
    expect(
      parse({
        action: "invoke_capabilities",
        invocations: [
          selection(complete.capabilityId),
          { ...selection(), controlsEvidenceExecutionIds: [] },
        ],
      }),
    ).toMatchObject({ ok: true });
    expect(
      parse({
        action: "invoke_capabilities",
        invocations: [selection(complete.capabilityId), selection()],
      }),
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "decision.invocations.1.controlsEvidenceExecutionIds",
        }),
      ]),
    });
  });

  test("C3: an empty eligible set accepts only an explicit empty selection", () => {
    const options = { ...contract(), eligibleControlsEvidenceExecutionIds: [] };
    for (const ids of [[], [evidence[0]]]) {
      const parsed = parseExecutionAgentDecisionOutput(
        JSON.stringify({
          decision: {
            action: "invoke_capability",
            ...selection(),
            controlsEvidenceExecutionIds: ids,
          },
        }),
        options,
      );
      expect(parsed.ok).toBe(ids.length === 0);
    }
  });
});
