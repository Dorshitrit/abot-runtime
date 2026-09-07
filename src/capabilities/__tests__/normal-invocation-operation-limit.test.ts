import { expect, test } from "vitest";
import { createToolRegistry } from "../registry.js";
import type { ToolModuleDeclaration } from "../tool-types.js";

function moduleWithOperations(count: number): ToolModuleDeclaration {
  return {
    definition: {
      name: "bounded_operations",
      description: "Bounded operation registration",
      routingCapability: "semantic_mutation",
    },
    implementation: async () => ({
      ok: true,
      output: "unused",
      producedNewInformation: false,
    }),
    normalInvocation: {
      version: 1,
      operations: Array.from({ length: count }, (_, index) => ({
        operationId: `operation_${index}`,
        summary: "One closed operation",
        effect: "mutating",
        approval: "request_policy",
        fixedParams: { action: `operation_${index}` },
        input: {
          type: "object",
          additionalProperties: false,
          properties: {},
          required: [],
        },
      })),
    },
  };
}

test.each([1, 16, 19, 32])(
  "registers and projects all %i declared operations",
  (count) => {
    const module = moduleWithOperations(count);
    const registry = createToolRegistry({ modules: [module] });
    expect(registry.getNormalInvocations()[0].contract.operations).toEqual(
      module.normalInvocation.operations,
    );
    expect(registry.getDefinitions()[0].params).toEqual({ action: "string" });
  },
);

test.each([0, 33])(
  "rejects %i operations outside the bounded contract",
  (count) => {
    expect(() =>
      createToolRegistry({ modules: [moduleWithOperations(count)] }),
    ).toThrow("1-32 operations");
  },
);
