import { describe, expect, test } from "vitest";
import { createToolRegistry } from "../registry.js";
import { validateToolNormalInvocationInput } from "../normal-invocation/index.js";
import type {
  ToolNormalInvocationInput,
  ToolNormalInvocationPropertyInput,
} from "../tool-types.js";

const stringInput = { type: "string", minLength: 1, maxLength: 32 } as const;

function register(
  properties: Record<string, unknown>,
  required: string[] = [],
) {
  return createToolRegistry({
    modules: [
      {
        definition: {
          name: "documented_lookup",
          description: "Inspect bounded values.",
          routingCapability: "semantic_lookup",
          catalogGroups: ["read"],
        },
        implementation: async () => ({ ok: true, output: "unused", producedNewInformation: false }),
        normalInvocation: {
          version: 1,
          operations: [
            {
              operationId: "inspect_values",
              summary: "Inspect values.",
              input: {
                type: "object",
                additionalProperties: false,
                properties,
                required,
              } as ToolNormalInvocationInput,
              effect: "read_only",
              approval: "request_policy",
            },
          ],
        },
      },
    ],
  }).getNormalInvocations()[0]!.contract.operations[0]!;
}

test("enforces fixed-width identifier patterns in inputs and their documented examples", () => {
  const schema = { ...stringInput, pattern: "^ref:[0-9a-f]{4}$" };
  const operation = register({ id: { ...schema, example: "ref:f3a9" } }, ["id"]);
  expect(validateToolNormalInvocationInput(operation, { id: "ref:f3a9" }).ok).toBe(true);
  expect(validateToolNormalInvocationInput(operation, { id: "ref:f3g9" }).ok).toBe(false);
  expect(() => register({ id: { ...schema, example: "ref:f3g9" } })).toThrow();
  for (const pattern of ["ref:[a-z]{4}", "^(a+)+$", "^[z-a]{4}$", 42]) {
    expect(() => register({ id: { ...schema, pattern } })).toThrow(/pattern/u);
  }
});

describe("plugin input documentation", () => {
  test("preserves old contracts and does not turn examples into defaults", () => {
    const plain = register({ term: stringInput });
    const documented = register({
      term: {
        ...stringInput,
        description: "Filter by this term; omit for all entries.",
        example: "release",
      },
    });
    expect(plain.input.properties.term).toEqual(stringInput);
    expect(validateToolNormalInvocationInput(documented, {})).toEqual({
      ok: true,
      value: {},
    });
    expect(
      validateToolNormalInvocationInput(documented, { term: null }).ok,
    ).toBe(false);
    expect(
      validateToolNormalInvocationInput(documented, { term: "different" }),
    ).toEqual({ ok: true, value: { term: "different" } });
    expect(
      validateToolNormalInvocationInput(plain, { term: "different" }),
    ).toEqual(
      validateToolNormalInvocationInput(documented, { term: "different" }),
    );
  });

  test("captures a detached frozen array example with the canonical schema", () => {
    const example = ["first", "second"];
    const schema = {
      type: "array",
      items: stringInput,
      minItems: 0,
      maxItems: 3,
      description: " Labels. ",
      example,
    };
    const operation = register({ labels: schema }, ["labels"]);
    example.push("later");
    schema.description = "changed";
    const input = operation.input.properties.labels!;
    expect(input.description).toBe("Labels.");
    expect(input.example).toEqual(["first", "second"]);
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input.example)).toBe(true);
    expect(validateToolNormalInvocationInput(operation, {}).ok).toBe(false);
  });

  test.each([
    { type: "string", enum: ["small", "large"], example: "small" },
    { type: "integer", minimum: 1, maximum: 10, example: 5 },
    { type: "number", minimum: -1, maximum: 1, example: 0.5 },
    { type: "boolean", example: false },
    { type: "string", minLength: 0, example: "" },
  ])("accepts a schema-valid example: $type/$example", (schema) => {
    expect(register({ value: schema }).input.properties.value!.example).toEqual(
      schema.example,
    );
  });

  test.each([
    [{ ...stringInput, description: " " }, "description"],
    [{ ...stringInput, description: "x".repeat(513) }, "description"],
    [{ ...stringInput, description: 5 }, "description"],
    [{ ...stringInput, description: undefined }, "description"],
    [{ ...stringInput, example: null }, "must be a string"],
    [{ ...stringInput, example: undefined }, "must be a string"],
    [{ ...stringInput, example: "x".repeat(33) }, "at most 32"],
    [
      {
        type: "string",
        minLength: 0,
        maxLength: 2000,
        example: "x".repeat(1023),
      },
      "serialize",
    ],
    [{ type: "string", enum: ["one"], example: "two" }, "declared values"],
    [{ type: "integer", minimum: 1, maximum: 5, example: 1.5 }, "integer"],
    [{ type: "number", minimum: 1, maximum: 5, example: Infinity }, "number"],
    [{ type: "boolean", example: "false" }, "boolean"],
    [
      {
        type: "array",
        items: stringInput,
        minItems: 0,
        maxItems: 1,
        example: ["one", "two"],
      },
      "at most 1",
    ],
    [
      {
        type: "array",
        items: stringInput,
        minItems: 0,
        maxItems: 1,
        example: [3],
      },
      "must be a string",
    ],
    [{ ...stringInput, example: "valid", default: "invented" }, "exactly"],
    [
      {
        type: "array",
        items: { ...stringInput, description: "nested metadata" },
        minItems: 0,
        maxItems: 1,
      },
      "exactly",
    ],
  ])(
    "rejects invalid metadata without weakening structural validation",
    (schema, issue) => {
      expect(() => register({ value: schema })).toThrow(issue as string);
    },
  );

  test("accepts the documentation boundary and does not constrain actual values to example size", () => {
    const schema: ToolNormalInvocationPropertyInput = {
      type: "string",
      minLength: 0,
      maxLength: 2000,
      description: "x".repeat(512),
      example: "x".repeat(1022),
    };
    const operation = register({ value: schema });
    expect(operation.input.properties.value).toEqual(schema);
    expect(
      validateToolNormalInvocationInput(operation, { value: "x".repeat(1500) })
        .ok,
    ).toBe(true);
  });
});
