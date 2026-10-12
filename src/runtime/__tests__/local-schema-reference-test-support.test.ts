import { expect, test } from "vitest";
import { validateJsonSchemaValue } from "../model/json-schema-value.js";
import { inlineLocalSchemaReferences } from "./support/inline-local-schema-references.js";

test("test validator resolves chained local references and preserves sibling constraints", () => {
  const root = {
    $defs: {
      "report/value": { type: "integer", minimum: 1 },
      alias: { $ref: "#/$defs/report~1value" },
    },
    type: "object",
    properties: { value: { $ref: "#/$defs/alias", maximum: 3 } },
    required: ["value"],
    additionalProperties: false,
  };
  const before = JSON.stringify(root);
  const schema = inlineLocalSchemaReferences(root);
  expect(validateJsonSchemaValue(schema, { value: 2 })).toBeUndefined();
  for (const value of [0, 4, "2"])
    expect(validateJsonSchemaValue(schema, { value })).toBeDefined();
  expect(JSON.stringify(root)).toBe(before);
});

test.each([
  { $ref: "#/$defs/missing" },
  { $ref: "https://example.invalid/schema" },
  { $ref: "#/$defs/cycle", $defs: { cycle: { $ref: "#/$defs/cycle" } } },
  { $ref: "#/$defs/name~3", $defs: { "name~3": { type: "string" } } },
])("test validator fails explicitly on unresolved references: %j", (schema) => {
  expect(() => inlineLocalSchemaReferences(schema)).toThrow();
});
