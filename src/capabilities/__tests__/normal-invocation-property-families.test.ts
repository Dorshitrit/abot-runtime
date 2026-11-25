import { describe, expect, test } from "vitest";
import { createToolRegistry } from "../registry.js";
import { validateToolNormalInvocationInput } from "../normal-invocation/index.js";
import type { ToolNormalInvocationInput } from "../tool-types.js";

const text = { type: "string", minLength: 1, maxLength: 32 } as const;
const properties = {
  resource: text,
  offset: { type: "integer", minimum: 0, maximum: 100 },
  limit: { type: "integer", minimum: 1, maximum: 10 },
  marker: text,
  around: { type: "integer", minimum: 1, maximum: 10 },
} as const;
const families = [
  { propertyNames: { enum: ["resource", "offset", "limit"] } },
  { propertyNames: { enum: ["resource", "marker", "around"] } },
];

function register(extension: Record<string, unknown> = {}) {
  return createToolRegistry({ modules: [{
    definition: {
      name: "bounded_lookup", description: "Inspect a bounded resource.",
      routingCapability: "semantic_lookup", catalogGroups: ["read"],
    },
    implementation: async () => ({ ok: true, output: "unused", producedNewInformation: false }),
    normalInvocation: { version: 1, operations: [{
      operationId: "inspect_resource", summary: "Inspect a selected resource window.",
      input: {
        type: "object", additionalProperties: false, properties,
        required: ["resource"], ...extension,
      } as ToolNormalInvocationInput,
      effect: "read_only", approval: "request_policy",
    }] },
  }] }).getNormalInvocations()[0]!.contract.operations[0]!;
}

describe("normal invocation property families", () => {
  test.each([
    { resource: "entry" },
    { resource: "entry", offset: 0 },
    { resource: "entry", limit: 4 },
    { resource: "entry", offset: 0, limit: 4 },
    { resource: "entry", marker: "target" },
    { resource: "entry", around: 2 },
    { resource: "entry", marker: "target", around: 2 },
  ])("accepts complete and partial allowed families without defaults: %j", (controls) => {
    expect(validateToolNormalInvocationInput(register({ anyOf: families }), controls))
      .toEqual({ ok: true, value: controls });
  });

  test.each([
    { resource: "entry", offset: 0, marker: "target" },
    { resource: "entry", offset: 0, around: 2 },
    { resource: "entry", limit: 4, marker: "target" },
    { resource: "entry", limit: 4, around: 2 },
  ])("rejects a mixture while preserving contracts without a declaration: %j", (controls) => {
    expect(validateToolNormalInvocationInput(register({ anyOf: families }), controls))
      .toEqual({ ok: false, issue: "input properties do not match a declared mode" });
    expect(validateToolNormalInvocationInput(register(), controls))
      .toEqual({ ok: true, value: controls });
  });

  test.each([
    {}, { offset: 0 }, { resource: "" }, { resource: "entry", extra: true },
    { resource: "entry", offset: null }, { resource: "entry", offset: -1 },
    { resource: "entry", limit: 11 }, { resource: "entry", marker: 3 },
  ])("retains required, closed-property and value validation: %j", (controls) => {
    expect(validateToolNormalInvocationInput(register({ anyOf: families }), controls).ok).toBe(false);
    expect(validateToolNormalInvocationInput(register(), controls).ok).toBe(false);
  });

  test("captures detached frozen families as executable contract authority", () => {
    const input = structuredClone(families);
    const operation = register({ anyOf: input });
    input[0]!.propertyNames.enum.push("marker");
    const captured = operation.input.anyOf!;
    expect(captured).toEqual(families);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured[0])).toBe(true);
    expect(Object.isFrozen(captured[0]!.propertyNames)).toBe(true);
    expect(Object.isFrozen(captured[0]!.propertyNames.enum)).toBe(true);
    expect(validateToolNormalInvocationInput(operation, {
      resource: "entry", offset: 0, marker: "target",
    }).ok).toBe(false);
  });

  test.each([
    undefined, null, {}, [], [null], [{}],
    [{ propertyNames: {} }],
    [{ propertyNames: { enum: [] } }],
    [{ propertyNames: { enum: "resource" } }],
    [{ propertyNames: { enum: ["resource", 1] } }],
    [{ propertyNames: { enum: ["resource", "unknown"] } }],
    [{ propertyNames: { enum: ["resource", "resource"] } }],
    [{ propertyNames: { enum: ["resource"], additionalProperties: false } }],
    [{ propertyNames: { enum: ["resource"] }, required: ["resource"] }],
    [
      { propertyNames: { enum: ["offset", "limit"] } },
      { propertyNames: { enum: ["resource", "marker", "around"] } },
    ],
    [
      { propertyNames: { enum: ["resource", "offset"] } },
      { propertyNames: { enum: ["resource", "marker", "around"] } },
    ],
    [
      ...families,
      { propertyNames: { enum: ["limit", "offset", "resource"] } },
    ],
  ].map((anyOf) => ({ anyOf })))("rejects malformed, incomplete or undeclared property families: %j", ({ anyOf }) => {
    expect(() => register({ anyOf })).toThrow();
  });
});
