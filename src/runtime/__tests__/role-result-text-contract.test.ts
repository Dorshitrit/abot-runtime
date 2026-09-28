import { expect, test } from "vitest";
import type { ModelGatewayJsonSchemaFormat } from "../../model-gateway/types.js";
import {
  createPlannerDecisionFormat,
  parsePlannerDecisionOutput,
} from "../steps/planner-decision/index.js";
import {
  createWorkerDecisionFormat,
  parseWorkerDecisionOutput,
} from "../steps/worker-decision/index.js";

const LONG_RESULT = "Result data ".repeat(900);
const TERMINAL_CONTRACTS = [
  {
    name: "Worker failure",
    action: "return_failure",
    field: "reason",
    parse: (text: string) => parseWorkerDecisionOutput(text),
    format: () => createWorkerDecisionFormat(),
  },
  {
    name: "Planner result",
    action: "return_result",
    field: "result",
    parse: (text: string) => parsePlannerDecisionOutput(text),
    format: () => createPlannerDecisionFormat(),
  },
  {
    name: "Planner failure",
    action: "return_failure",
    field: "reason",
    parse: (text: string) => parsePlannerDecisionOutput(text),
    format: () => createPlannerDecisionFormat(),
  },
];

function terminalVariant(format: ModelGatewayJsonSchemaFormat, action: string) {
  const schema = format.schema as {
    properties: {
      decision: {
        anyOf: {
          required: string[];
          additionalProperties: boolean;
          properties: Record<string, unknown> & { action: { enum: string[] } };
        }[];
      };
    };
  };
  const variant = schema.properties.decision.anyOf.find(
    (entry) => entry.properties.action.enum.includes(action),
  );
  expect(variant).toBeDefined();
  return variant!;
}

test.each(TERMINAL_CONTRACTS)(
  "$name accepts complete long text while preserving its terminal shape",
  ({ action, field, parse, format }) => {
    expect(LONG_RESULT.length).toBeGreaterThan(8_192);
    const value = { action, [field]: LONG_RESULT.trim() };
    expect(parse(JSON.stringify({ decision: value }))).toEqual({
      ok: true,
      decision: value,
    });
    const definition = format();
    const variant = terminalVariant(definition, action);
    expect(variant.required).toEqual(["action", field]);
    expect(variant.additionalProperties).toBe(false);
    expect(variant.properties[field]).toEqual({ type: "string", minLength: 1 });
    expect(definition.postValidatedSchemaConstraints).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.stringContaining(`/properties/${field}/maxLength`),
        }),
      ]),
    );
  },
);

test.each(TERMINAL_CONTRACTS)(
  "$name still rejects absent, malformed, empty and whitespace-only text",
  ({ action, field, parse }) => {
    for (const value of [undefined, null, 17, {}, [], "", " \n\t "]) {
      expect(parse(JSON.stringify({ decision: { action, [field]: value } })))
        .toMatchObject({ ok: false, stage: "domain_parser" });
    }
    expect(parse(JSON.stringify({
      decision: { action, [field]: LONG_RESULT, extra: "unsupported" },
    }))).toMatchObject({ ok: false, stage: "domain_parser" });
  },
);
