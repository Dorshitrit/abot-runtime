import { describe, expect, test } from "vitest";

import { estimateStrictStructuredOutputTokenCeiling } from "./budget.js";

describe("strict structured output budget", () => {
  test("derives a finite ceiling from bounded nested JSON", () => {
    expect(
      estimateStrictStructuredOutputTokenCeiling({
        type: "json_schema",
        name: "bounded",
        strict: true,
        schema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["done"] },
            values: {
              type: "array",
              maxItems: 2,
              items: { type: "string", maxLength: 4 },
            },
          },
          required: ["action", "values"],
          additionalProperties: false,
        },
      }),
    ).toBe(22);
  });

  test("uses the largest bounded union branch", () => {
    expect(
      estimateStrictStructuredOutputTokenCeiling({
        type: "json_schema",
        name: "union",
        strict: true,
        schema: {
          anyOf: [
            { type: "string", maxLength: 2 },
            { type: "string", maxLength: 10 },
          ],
        },
      }),
    ).toBe(7);
  });

  test("does not invent a ceiling for an unbounded or non-strict schema", () => {
    expect(
      estimateStrictStructuredOutputTokenCeiling({
        type: "json_schema",
        name: "unbounded",
        strict: true,
        schema: { type: "string" },
      }),
    ).toBeUndefined();
    expect(
      estimateStrictStructuredOutputTokenCeiling({
        type: "json_schema",
        name: "non_strict",
        strict: false,
        schema: { type: "string", maxLength: 10 },
      }),
    ).toBeUndefined();
  });
});
