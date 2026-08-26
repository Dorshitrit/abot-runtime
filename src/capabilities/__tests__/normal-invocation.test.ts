import { describe, expect, test } from "vitest";

import {
  validateToolNormalInvocationInput,
  validateToolNormalInvocationPayload,
} from "../normal-invocation/index.js";
import { createToolRegistry } from "../registry.js";
import type {
  ToolModuleDeclaration,
  ToolNormalInvocationContract,
} from "../tool-types.js";

describe("normal tool invocation contract", () => {
  test("registers one closed provider-safe contract with its definition and adapter", () => {
    const adapter = {
      normalizeCall: ({
        tool,
        params,
      }: {
        tool: string;
        params: Record<string, unknown>;
      }) => ({ tool, params: { ...params, normalized: true } }),
    };
    const registry = createToolRegistry({
      modules: [createNormalModule({ adapter })],
    });

    const registrations = registry.getNormalInvocations();
    expect(registrations).toHaveLength(1);
    expect(registrations[0]).toMatchObject({
      toolName: "host_document",
      definition: { name: "host_document" },
      adapter,
      contract: {
        version: 1,
        operations: [
          {
            operationId: "create_document",
            fixedParams: { command: "create" },
            effect: "mutating",
            approval: "always",
            payload: {
              kind: "raw_text",
              param: "body",
              maxBytes: 8,
            },
          },
        ],
      },
    });
    expect(Object.isFrozen(registrations)).toBe(true);
    expect(Object.isFrozen(registrations[0])).toBe(true);
    expect(Object.isFrozen(registrations[0]?.contract.operations)).toBe(true);
    expect(
      registrations[0]?.contract.operations[0]?.payload,
    ).not.toHaveProperty("minBytes");
    expect(registry.getNormalInvocations()).toBe(registrations);
  });

  test("post-validates exact scalar and array inputs plus raw payload bytes", () => {
    const operation = createNormalModule().normalInvocation?.operations[0];
    expect(operation).toBeDefined();
    if (!operation) return;

    expect(
      validateToolNormalInvocationInput(operation, {
        title: "Roadmap",
        priority: 3,
        published: false,
        labels: ["planning", "review"],
      }),
    ).toEqual({
      ok: true,
      value: {
        title: "Roadmap",
        priority: 3,
        published: false,
        labels: ["planning", "review"],
      },
    });
    expect(
      validateToolNormalInvocationInput(operation, {
        title: "Roadmap",
        unknown: true,
      }),
    ).toMatchObject({ ok: false, issue: expect.stringContaining("unknown") });
    expect(validateToolNormalInvocationInput(operation, {})).toMatchObject({
      ok: false,
      issue: expect.stringContaining("missing required property title"),
    });
    expect(validateToolNormalInvocationPayload(operation, "12345678")).toBe(
      undefined,
    );
    expect(validateToolNormalInvocationPayload(operation, "123456789")).toBe(
      "payload exceeds 8 bytes",
    );
    expect(
      validateToolNormalInvocationPayload(operation, { body: "text" }),
    ).toBe("payload must be raw text");
    expect(
      validateToolNormalInvocationInput(operation, {
        title: "x".repeat(121),
      }),
    ).toEqual({
      ok: false,
      issue: "input.title must contain at most 120 characters",
    });
  });

  test("accepts an explicitly unbounded string beyond the bounded-string ceiling", () => {
    const base = createNormalModule();
    const operation = base.normalInvocation?.operations[0];
    if (!operation) throw new Error("missing test operation");
    const module: ToolModuleDeclaration = {
      ...base,
      normalInvocation: {
        version: 1,
        operations: [
          {
            ...operation,
            input: {
              ...operation.input,
              properties: {
                ...operation.input.properties,
                title: { type: "string", minLength: 3 },
              },
            },
          },
        ],
      },
    };
    const [registered] = createToolRegistry({
      modules: [module],
    }).getNormalInvocations()[0]!.contract.operations;
    if (!registered) throw new Error("missing registered operation");
    const longTitle = "x".repeat(4_097);

    expect(registered.input.properties.title).toEqual({
      type: "string",
      minLength: 3,
    });
    expect(
      validateToolNormalInvocationInput(registered, { title: longTitle }),
    ).toEqual({ ok: true, value: { title: longTitle } });
    expect(
      validateToolNormalInvocationInput(registered, { title: "xx" }),
    ).toEqual({
      ok: false,
      issue: "input.title must contain at least 3 characters",
    });
  });

  test("projects an optional minimum raw-payload byte bound and validates it before the maximum", () => {
    const module = createNormalModule();
    const contract = structuredClone(module.normalInvocation);
    const operation = contract.operations[0];
    if (!operation?.payload) throw new Error("missing test payload");
    operation.payload.minBytes = 1;

    const [registration] = createToolRegistry({
      modules: [
        {
          ...module,
          normalInvocation: contract,
        },
      ],
    }).getNormalInvocations();
    const projectedOperation = registration?.contract.operations[0];
    expect(projectedOperation?.payload).toEqual({
      kind: "raw_text",
      param: "body",
      instructions: "Provide the complete document body as raw text.",
      minBytes: 1,
      maxBytes: 8,
    });
    if (!projectedOperation) throw new Error("missing projected operation");
    expect(validateToolNormalInvocationPayload(projectedOperation, "")).toBe(
      "payload is smaller than 1 bytes",
    );
    expect(validateToolNormalInvocationPayload(projectedOperation, "x")).toBe(
      undefined,
    );
  });

  test("rejects declarations without a canonical ordinary invocation", () => {
    const withoutContract = {
      definition: {
        name: "legacy_lookup",
        routingCapability: "semantic_lookup",
        params: { query: "string" },
      },
      implementation: async () => ({
        output: "ok",
        producedNewInformation: true,
      }),
    } as unknown as ToolModuleDeclaration;

    expect(() => createToolRegistry({ modules: [withoutContract] })).toThrow(
      "Invalid tool module for legacy_lookup (normalInvocation is required)",
    );
  });

  test.each([
    {
      label: "root union",
      mutate: (contract: Record<string, unknown>) => {
        const operations = contract.operations as Array<
          Record<string, unknown>
        >;
        operations[0] = { ...(operations[0] ?? {}), input: { oneOf: [] } };
      },
      issue: "expected an exact object schema",
    },
    {
      label: "unknown operation field",
      mutate: (contract: Record<string, unknown>) => {
        const operations = contract.operations as Array<
          Record<string, unknown>
        >;
        operations[0] = { ...(operations[0] ?? {}), retry: true };
      },
      issue: "operation must contain",
    },
    {
      label: "overlapping fixed param",
      mutate: (contract: Record<string, unknown>) => {
        const operations = contract.operations as Array<
          Record<string, unknown>
        >;
        operations[0] = {
          ...(operations[0] ?? {}),
          fixedParams: { title: "fixed" },
        };
      },
      issue: "parameter title cannot be both input and fixed",
    },
    {
      label: "string without a minimum",
      mutate: (contract: Record<string, unknown>) => {
        const operations = contract.operations as Array<
          Record<string, unknown>
        >;
        const operation = operations[0] ?? {};
        operation.input = {
          type: "object",
          additionalProperties: false,
          properties: { title: { type: "string" } },
          required: ["title"],
        };
      },
      issue: "unbounded string input must contain exactly type and minLength",
    },
    {
      label: "negative payload minimum",
      mutate: (contract: Record<string, unknown>) => {
        const operations = contract.operations as Array<
          Record<string, unknown>
        >;
        const operation = operations[0] ?? {};
        operation.payload = {
          ...(operation.payload as Record<string, unknown>),
          minBytes: -1,
        };
      },
      issue: "expected a safe integer between 0",
    },
    {
      label: "payload minimum above its maximum",
      mutate: (contract: Record<string, unknown>) => {
        const operations = contract.operations as Array<
          Record<string, unknown>
        >;
        const operation = operations[0] ?? {};
        operation.payload = {
          ...(operation.payload as Record<string, unknown>),
          minBytes: 9,
        };
      },
      issue: "expected minBytes not to exceed maxBytes",
    },
    {
      label: "nested object property",
      mutate: (contract: Record<string, unknown>) => {
        const operations = contract.operations as Array<
          Record<string, unknown>
        >;
        const operation = operations[0] ?? {};
        operation.input = {
          type: "object",
          additionalProperties: false,
          properties: {
            nested: {
              type: "object",
              additionalProperties: false,
              properties: {},
              required: [],
            },
          },
          required: [],
        };
      },
      issue: "expected string, number, integer or boolean",
    },
  ])(
    "rejects unsafe or open $label contracts during registry loading",
    ({ mutate, issue }) => {
      const module = createNormalModule();
      const contract = structuredClone(
        module.normalInvocation,
      ) as unknown as Record<string, unknown>;
      mutate(contract);

      expect(() =>
        createToolRegistry({
          modules: [
            {
              ...module,
              normalInvocation:
                contract as unknown as ToolNormalInvocationContract,
            },
          ],
        }),
      ).toThrow(issue);
    },
  );

  test.each([
    {
      field: "params",
      value: { title: "string" },
      issue: "params must be omitted when normalInvocation is canonical",
    },
    {
      field: "executionEffect",
      value: "mutating",
      issue:
        "executionEffect must be omitted when normalInvocation is canonical",
    },
  ])(
    "rejects manually authored definition.$field on a canonical declaration",
    ({ field, value, issue }) => {
      const module = createNormalModule();
      expect(() =>
        createToolRegistry({
          modules: [
            {
              ...module,
              definition: { ...module.definition, [field]: value },
            } as unknown as ToolModuleDeclaration,
          ],
        }),
      ).toThrow(issue);
    },
  );

  test("derives the compatibility projection from one canonical contract", () => {
    const module = createNormalModule();
    expect(module.definition).not.toHaveProperty("params");
    expect(module.definition).not.toHaveProperty("executionEffect");

    expect(
      createToolRegistry({ modules: [module] }).getDefinitions()[0],
    ).toEqual({
      name: "host_document",
      description: "Create a host document.",
      routingCapability: "semantic_mutation",
      catalogGroups: ["write"],
      executionEffect: "mutating",
      params: {
        title: "string",
        priority: "number",
        published: "boolean",
        labels: "string[]",
        command: "string",
        body: "string",
      },
    });
  });
});

function createNormalModule(
  params: { adapter?: ToolModuleDeclaration["adapter"] } = {},
): ToolModuleDeclaration {
  return {
    definition: {
      name: "host_document",
      description: "Create a host document.",
      routingCapability: "semantic_mutation",
      catalogGroups: ["write"],
    },
    implementation: async () => ({
      ok: true,
      output: "created",
      producedNewInformation: true,
    }),
    ...(params.adapter ? { adapter: params.adapter } : {}),
    normalInvocation: {
      version: 1,
      operations: [
        {
          operationId: "create_document",
          summary: "Create one host document from raw text.",
          input: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: "string", minLength: 1, maxLength: 120 },
              priority: { type: "integer", minimum: 1, maximum: 10 },
              published: { type: "boolean" },
              labels: {
                type: "array",
                items: { type: "string", minLength: 0, maxLength: 32 },
                minItems: 0,
                maxItems: 8,
              },
            },
            required: ["title"],
          },
          fixedParams: { command: "create" },
          payload: {
            kind: "raw_text",
            param: "body",
            instructions: "Provide the complete document body as raw text.",
            maxBytes: 8,
          },
          effect: "mutating",
          approval: "always",
        },
      ],
    },
  };
}
