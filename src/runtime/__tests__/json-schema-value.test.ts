import { describe, expect, test } from "vitest";

import { validateJsonSchemaValue } from "../model/json-schema-value.js";

describe("validateJsonSchemaValue", () => {
  const schema = Object.freeze({
    type: "object",
    properties: Object.freeze({
      placement: Object.freeze({
        type: "string",
        enum: Object.freeze(["replace", "delete"]),
      }),
      line: Object.freeze({
        type: "integer",
        minimum: 1,
        maximum: 2,
      }),
    }),
    required: Object.freeze(["placement", "line"]),
    additionalProperties: false,
  });

  test("validates required, enum, numeric bounds, and exact properties", () => {
    expect(validateJsonSchemaValue(schema, {})).toEqual({
      path: "output/placement",
      message: "A required property is missing.",
    });
    expect(
      validateJsonSchemaValue(schema, { placement: "sideways", line: 1 }),
    ).toEqual({
      path: "output/placement",
      message: "The value must match one declared enum value.",
    });
    expect(
      validateJsonSchemaValue(schema, { placement: "replace", line: 3 }),
    ).toEqual({
      path: "output/line",
      message: "The number exceeds the declared maximum.",
    });
    expect(
      validateJsonSchemaValue(schema, {
        placement: "replace",
        line: 1,
      }),
    ).toBeUndefined();
  });

  test("does not disclose a model-controlled additional-property name", () => {
    const secretProperty = "MODEL_SECRET_PROPERTY_MUST_NOT_ESCAPE";
    const result = validateJsonSchemaValue(schema, {
      placement: "replace",
      line: 1,
      [secretProperty]: true,
    });
    expect(result).toEqual({
      path: "output",
      message: "The property is not declared by the response format.",
    });
    expect(JSON.stringify(result)).not.toContain(secretProperty);
  });

  test("enforces json_object and counts Unicode code points for string bounds", () => {
    expect(
      validateJsonSchemaValue({ type: "json_object" }, ["not", "object"]),
    ).toEqual({
      path: "output",
      message: "The response must be one JSON object.",
    });
    expect(
      validateJsonSchemaValue({ type: "string", maxLength: 1 }, "🫡"),
    ).toBeUndefined();
  });
});
