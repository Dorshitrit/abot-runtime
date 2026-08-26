import { describe, expect, test } from "vitest";

import { createToolRegistry } from "../registry.js";
import { buildToolRegistry } from "../tool-definition-validator.js";
import type { ToolModuleDeclaration } from "../tool-types.js";

describe("tool registry", () => {
  test("builds an isolated registry only from supplied modules", async () => {
    const module = createLookupModule("custom_lookup");
    const registry = createToolRegistry({ modules: [module] });

    expect(registry.getDefinitions()).toEqual([
      {
        name: "custom_lookup",
        description: "Look up host-owned information.",
        routingCapability: "semantic_lookup",
        catalogGroups: ["read"],
        executionEffect: "read_only",
        params: { query: "string" },
      },
    ]);
    expect(registry.hasToolsAvailable()).toBe(true);
    expect(registry.getByName("custom_lookup")?.name).toBe("custom_lookup");
    expect(registry.getByName("undeclared_tool")).toBeUndefined();
    await expect(
      registry.getImplementations().custom_lookup?.({ query: "runtime" }),
    ).resolves.toMatchObject({ output: "result:runtime" });
  });

  test("has no implicit central catalog", () => {
    const registry = createToolRegistry();

    expect(registry.getDefinitions()).toEqual([]);
    expect(registry.getImplementations()).toEqual({});
    expect(registry.getNormalInvocations()).toEqual([]);
    expect(registry.hasToolsAvailable()).toBe(false);
  });

  test("preserves the declaration-owned adapter and invocation contract", () => {
    const adapter = {
      normalizeCall: ({
        tool,
        params,
      }: {
        tool: string;
        params: Record<string, unknown>;
      }) => ({ tool, params: { query: params.q } }),
    };
    const registry = createToolRegistry({
      modules: [createLookupModule("host_lookup", adapter)],
    });

    expect(
      registry.getAdapterByName("host_lookup")?.normalizeCall?.({
        tool: "host_lookup",
        params: { q: "runtime" },
      }),
    ).toEqual({ tool: "host_lookup", params: { query: "runtime" } });
    expect(registry.getNormalInvocations()).toMatchObject([
      {
        toolName: "host_lookup",
        definition: {
          name: "host_lookup",
          executionEffect: "read_only",
        },
        contract: {
          version: 1,
          operations: [
            {
              operationId: "lookup",
              effect: "read_only",
              approval: "request_policy",
            },
          ],
        },
        adapter,
      },
    ]);
  });

  test("preserves an explicitly unbounded string input", () => {
    const base = createLookupModule("unbounded_lookup");
    const operation = base.normalInvocation?.operations[0];
    if (!operation) throw new Error("missing lookup operation");
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
                query: { type: "string", minLength: 1 },
              },
            },
          },
        ],
      },
    };

    const [registered] = createToolRegistry({
      modules: [module],
    }).getNormalInvocations()[0]!.contract.operations;

    expect(registered?.input.properties.query).toEqual({
      type: "string",
      minLength: 1,
    });
  });

  test("disables selected capability ids without mutating declarations", () => {
    const alpha = createLookupModule("alpha_lookup");
    const beta = createLookupModule("beta_lookup");
    const registry = createToolRegistry({
      modules: [alpha, beta],
      disabledTools: [" beta_lookup ", ""],
    });

    expect(registry.getDefinitions().map(({ name }) => name)).toEqual([
      "alpha_lookup",
    ]);
    expect(registry.getImplementations()).not.toHaveProperty("beta_lookup");
    expect(alpha.definition.name).toBe("alpha_lookup");
    expect(beta.definition.name).toBe("beta_lookup");
  });

  test("rejects duplicate and invalid declarations", () => {
    expect(() =>
      buildToolRegistry([
        createLookupModule("duplicate_lookup"),
        createLookupModule("duplicate_lookup"),
      ]),
    ).toThrow("Duplicate tool definition: duplicate_lookup");
    expect(() =>
      buildToolRegistry([
        {
          ...createLookupModule("valid_name"),
          definition: {
            ...createLookupModule("valid_name").definition,
            name: "",
          },
        } as ToolModuleDeclaration,
      ]),
    ).toThrow("Invalid tool definition entry (name)");
    expect(() =>
      buildToolRegistry([
        {
          ...createLookupModule("invalid_catalog_group"),
          definition: {
            ...createLookupModule("invalid_catalog_group").definition,
            catalogGroups: ["Invalid Group"],
          },
        } as unknown as ToolModuleDeclaration,
      ]),
    ).toThrow(
      "Invalid tool definition for invalid_catalog_group (catalogGroups)",
    );
  });

  test.each([
    {
      label: "coexists with minBytesOverride",
      mutate(module: MutableStagedLiteralModule) {
        module.definition.payloadChannelSpec.stages[1]!.minBytesOverride = {
          materializedParam: "selection",
          property: "placement",
          equals: "delete",
          minBytes: 0,
        };
      },
    },
    {
      label: "references the current rather than a prior stage",
      mutate(module: MutableStagedLiteralModule) {
        module.definition.payloadChannelSpec.stages[1]!.includeMaterializedParams =
          ["content"];
        literalOutput(module).when.materializedParam = "content";
      },
    },
    {
      label: "depends on a property without a required string enum",
      mutate(module: MutableStagedLiteralModule) {
        const format = module.definition.payloadChannelSpec.stages[0]!
          .responseFormat as MutableResponseFormat;
        format.properties.placement = { type: "string" };
      },
    },
    {
      label: "depends on a source property that is not required",
      mutate(module: MutableStagedLiteralModule) {
        const format = module.definition.payloadChannelSpec.stages[0]!
          .responseFormat as MutableResponseFormat;
        format.required = [];
      },
    },
    {
      label: "matches a value outside the source enum",
      mutate(module: MutableStagedLiteralModule) {
        literalOutput(module).when.equals = "append";
      },
    },
    {
      label: "omits the dependency from included materialized params",
      mutate(module: MutableStagedLiteralModule) {
        module.definition.payloadChannelSpec.stages[1]!.includeMaterializedParams =
          [];
      },
    },
    {
      label: "contains an oversized literal",
      mutate(module: MutableStagedLiteralModule) {
        literalOutput(module).value = "x".repeat(4_097);
      },
    },
    {
      label: "is declared on a non-final stage",
      mutate(module: MutableStagedLiteralModule) {
        const spec = module.definition.payloadChannelSpec;
        const literalStage = {
          ...spec.stages[1]!,
          outputParam: "intermediate",
        };
        delete literalStage.minBytes;
        delete spec.stages[1]!.literalOutput;
        spec.params = ["selection", "intermediate", "content"];
        spec.stages = [
          spec.stages[0]!,
          literalStage,
          {
            outputParam: "content",
            promptHint: "Return final raw content.",
          },
        ];
        const input = module.normalInvocation.operations[0]!.input;
        input.properties.intermediate = {
          type: "string",
          minLength: 1,
          maxLength: 128,
        };
        input.required.push("intermediate");
      },
    },
    {
      label: "shares a stage with a response format",
      mutate(module: MutableStagedLiteralModule) {
        module.definition.payloadChannelSpec.stages[1]!.responseFormat = "json";
      },
    },
    {
      label: "shares a stage with target line bounds",
      mutate(module: MutableStagedLiteralModule) {
        const spec = module.definition.payloadChannelSpec;
        spec.targetParam = "path";
        const finalStage = spec.stages[1]!;
        finalStage.targetContext = "full_numbered";
        finalStage.responseFormat = {
          type: "object",
          properties: { line: { type: "integer" } },
          required: ["line"],
        };
        finalStage.targetLineBoundProperties = ["line"];
        const input = module.normalInvocation.operations[0]!.input;
        input.properties.path = {
          type: "string",
          minLength: 1,
          maxLength: 4_096,
        };
        input.required.push("path");
      },
    },
    {
      label: "has a malformed condition shape",
      mutate(module: MutableStagedLiteralModule) {
        const output = module.definition.payloadChannelSpec.stages[1]!
          .literalOutput as Record<string, unknown>;
        output.when = { materializedParam: "selection" };
      },
    },
  ])("rejects a staged literal that $label", ({ mutate }) => {
    const module = createStagedLiteralModule();
    mutate(module as unknown as MutableStagedLiteralModule);

    expect(() => buildToolRegistry([module])).toThrow();
  });
});

type MutableResponseFormat = {
  properties: Record<string, Record<string, unknown>>;
  required: string[];
};

type MutableStagedLiteralModule = {
  definition: {
    payloadChannelSpec: {
      params: string[];
      outputParam: string;
      targetParam?: string;
      stages: Array<Record<string, unknown>>;
    };
  };
  normalInvocation: {
    operations: [
      {
        input: {
          properties: Record<string, Record<string, unknown>>;
          required: string[];
        };
      },
    ];
  };
};

function literalOutput(module: MutableStagedLiteralModule): {
  when: { materializedParam: string; property: string; equals: string };
  value: string;
} {
  return module.definition.payloadChannelSpec.stages[1]!.literalOutput as {
    when: { materializedParam: string; property: string; equals: string };
    value: string;
  };
}

function createLookupModule(
  name: string,
  adapter?: ToolModuleDeclaration["adapter"],
): ToolModuleDeclaration {
  return {
    definition: {
      name,
      description: "Look up host-owned information.",
      routingCapability: "semantic_lookup",
      catalogGroups: ["read"],
    },
    normalInvocation: {
      version: 1,
      operations: [
        {
          operationId: "lookup",
          summary: "Look up host-owned information.",
          input: {
            type: "object",
            additionalProperties: false,
            properties: {
              query: { type: "string", minLength: 1, maxLength: 128 },
            },
            required: ["query"],
          },
          effect: "read_only",
          approval: "request_policy",
        },
      ],
    },
    ...(adapter ? { adapter } : {}),
    implementation: async ({ query }) => ({
      ok: true,
      output: `result:${String(query ?? "")}`,
      producedNewInformation: true,
    }),
  };
}

function createStagedLiteralModule(): ToolModuleDeclaration {
  return {
    definition: {
      name: "staged_literal_writer",
      description: "Apply one staged edit.",
      routingCapability: "filesystem_mutation",
      catalogGroups: ["write"],
      payloadChannelSpec: {
        params: ["selection", "content"],
        outputParam: "content",
        generationMode: "raw_text",
        stages: [
          {
            outputParam: "selection",
            responseFormat: {
              type: "object",
              properties: {
                placement: {
                  type: "string",
                  enum: ["replace", "delete"],
                },
              },
              required: ["placement"],
              additionalProperties: false,
            },
            promptHint: "Return one placement object.",
          },
          {
            outputParam: "content",
            includeMaterializedParams: ["selection"],
            minBytes: 1,
            literalOutput: {
              when: {
                materializedParam: "selection",
                property: "placement",
                equals: "delete",
              },
              value: "",
            },
            promptHint: "Return raw replacement content.",
          },
        ],
      },
    },
    normalInvocation: {
      version: 1,
      operations: [
        {
          operationId: "edit_staged_literal",
          summary: "Apply one staged edit.",
          input: {
            type: "object",
            additionalProperties: false,
            properties: {
              instruction: {
                type: "string",
                minLength: 1,
                maxLength: 4_096,
              },
              selection: {
                type: "string",
                minLength: 1,
                maxLength: 4_096,
              },
            },
            required: ["instruction", "selection"],
          },
          effect: "mutating",
          approval: "request_policy",
          payload: {
            kind: "raw_text",
            param: "content",
            instructions: "Return raw replacement content.",
            maxBytes: 1_024,
          },
        },
      ],
    },
    implementation: async () => ({
      ok: true,
      output: "unused",
      producedNewInformation: false,
    }),
  };
}
