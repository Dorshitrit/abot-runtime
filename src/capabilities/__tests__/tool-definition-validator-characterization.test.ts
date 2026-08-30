import { describe, expect, test } from "vitest";

import {
  buildToolRegistry,
  parseToolDefinition,
  validateToolModuleDeclarations,
} from "../tool-definition-validator.js";
import type { ToolModuleDeclaration } from "../tool-types.js";

type MutableStagedDefinition = {
  name: string;
  routingCapability: "filesystem_mutation";
  params: Record<string, string>;
  payloadChannelSpec: {
    params: string[];
    outputParam: string;
    generationMode: "raw_text";
    stages: Record<string, unknown>[];
  };
};

describe("tool definition validator characterization", () => {
  test("preserves normalized definition projection", () => {
    const parsed = parseToolDefinition({
      name: "characterization_writer",
      routingCapability: "filesystem_mutation",
      params: { path: "string", selection: "string", content: "string" },
      runtimePathBindings: [
        {
          operationId: " write ",
          param: " path ",
          base: "worker_working_directory",
          default: ".",
        },
      ],
      eventPresentation: {
        metadata: {
          target: { param: " path ", kind: "string", default: false },
        },
        lifecycle: {
          started: { status: " Working ", message: " Applying " },
        },
      },
      payloadChannelSpec: {
        params: ["selection", "content"],
        outputParam: "content",
        generationMode: "raw_text",
        targetParam: "path",
        targetRole: "operation_target",
        contextScope: "target_with_artifacts",
        targetContext: "full_numbered",
        stages: validStages(),
        requiresCurrentTargetObservation: {
          targetParam: "path",
          contentRequirement: "full",
        },
      },
    });

    expect(parsed).toEqual({
      name: "characterization_writer",
      routingCapability: "filesystem_mutation",
      catalogGroups: ["other"],
      eventPresentation: {
        metadata: {
          target: { param: "path", kind: "string", default: false },
        },
        lifecycle: {
          started: { status: "Working", message: "Applying" },
        },
      },
      params: { path: "string", selection: "string", content: "string" },
      payloadChannelSpec: {
        params: ["selection", "content"],
        outputParam: "content",
        generationMode: "raw_text",
        targetParam: "path",
        targetRole: "operation_target",
        contextScope: "target_with_artifacts",
        targetContext: "full_numbered",
        stages: validStages(),
        requiresCurrentTargetObservation: {
          targetParam: "path",
          contentRequirement: "full",
        },
      },
      runtimePathBindings: [
        {
          operationId: "write",
          param: "path",
          base: "worker_working_directory",
          default: ".",
        },
      ],
    });
    expect(Object.isFrozen(parsed.runtimePathBindings?.[0])).toBe(true);
  });

  test("preserves validation precedence across definition sections", () => {
    const raw: Record<string, unknown> = {
      ...createStagedDefinition(),
      paramsByCommand: [],
      runtimePathBindings: [],
      payloadChannelSpec: {},
      eventPresentation: [],
      catalogGroups: [],
    };

    expect(() => parseToolDefinition(raw)).toThrow(
      "Invalid tool definition for staged_writer (paramsByCommand)",
    );
    delete raw.paramsByCommand;
    expect(() => parseToolDefinition(raw)).toThrow(
      "Invalid tool definition for staged_writer (runtimePathBindings)",
    );
    delete raw.runtimePathBindings;
    expect(() => parseToolDefinition(raw)).toThrow(
      "Invalid tool definition for staged_writer (payloadChannelSpec.params)",
    );
    delete raw.payloadChannelSpec;
    expect(() => parseToolDefinition(raw)).toThrow(
      "Invalid tool definition for staged_writer (eventPresentation)",
    );
    delete raw.eventPresentation;
    expect(() => parseToolDefinition(raw)).toThrow(
      "Invalid tool definition for staged_writer (catalogGroups)",
    );
  });

  test("preserves command variant projection and nested error paths", () => {
    const definition = {
      ...createStagedDefinition(),
      paramsByCommand: {
        discriminator: "command",
        variants: {
          inspect: { selection: "string" },
          mutate: { selection: "string", content: "string" },
        },
      },
    };

    expect(parseToolDefinition(definition).paramsByCommand).toEqual({
      discriminator: "command",
      variants: {
        inspect: { selection: "string" },
        mutate: { selection: "string", content: "string" },
      },
    });

    definition.paramsByCommand.variants.mutate.content =
      42 as unknown as string;
    expect(() => parseToolDefinition(definition)).toThrow(
      "Invalid tool definition for staged_writer (paramsByCommand.variants.mutate.content)",
    );
  });

  test.each([
    {
      label: "unavailable materialized input",
      expected:
        "Invalid tool definition for staged_writer (payloadChannelSpec.stages.1 references unavailable materialized params)",
      mutate(definition: MutableStagedDefinition) {
        definition.payloadChannelSpec.stages[1]!.includeMaterializedParams = [
          "content",
        ];
      },
    },
    {
      label: "literal output with a duplicate source stage",
      expected:
        "Invalid tool definition for staged_writer (payloadChannelSpec.stages.2.literalOutput source)",
      mutate(definition: MutableStagedDefinition) {
        definition.payloadChannelSpec.stages.splice(1, 0, {
          outputParam: "selection",
        });
      },
    },
    {
      label: "literal output rejected by its source schema",
      expected:
        "Invalid tool definition for staged_writer (payloadChannelSpec.stages.1.literalOutput schema)",
      mutate(definition: MutableStagedDefinition) {
        const responseFormat = definition.payloadChannelSpec.stages[0]!
          .responseFormat as { required: string[] };
        responseFormat.required = [];
      },
    },
    {
      label: "malformed literal output condition",
      expected:
        "Invalid tool definition for staged_writer (payloadChannelSpec.stages.1.literalOutput)",
      mutate(definition: MutableStagedDefinition) {
        const literalOutput = definition.payloadChannelSpec.stages[1]!
          .literalOutput as { when: Record<string, unknown> };
        delete literalOutput.when.property;
      },
    },
  ])("preserves the exact $label error", ({ expected, mutate }) => {
    const definition = createStagedDefinition();
    mutate(definition);

    expect(() => parseToolDefinition(definition)).toThrow(expected);
  });

  test("preserves minBytesOverride projection and exact source/schema errors", () => {
    const definition = createStagedDefinition();
    delete definition.payloadChannelSpec.stages[1]!.literalOutput;
    definition.payloadChannelSpec.stages[1]!.minBytesOverride = {
      materializedParam: "selection",
      property: "placement",
      equals: "replace",
      minBytes: 7,
    };

    expect(
      parseToolDefinition(definition).payloadChannelSpec?.stages?.[1]
        ?.minBytesOverride,
    ).toEqual({
      materializedParam: "selection",
      property: "placement",
      equals: "replace",
      minBytes: 7,
    });

    const duplicateSource = createStagedDefinition();
    delete duplicateSource.payloadChannelSpec.stages[1]!.literalOutput;
    duplicateSource.payloadChannelSpec.stages[1]!.minBytesOverride = {
      materializedParam: "selection",
      property: "placement",
      equals: "replace",
      minBytes: 7,
    };
    duplicateSource.payloadChannelSpec.stages.splice(1, 0, {
      outputParam: "selection",
    });
    expect(() => parseToolDefinition(duplicateSource)).toThrow(
      "Invalid tool definition for staged_writer (payloadChannelSpec.stages.2.minBytesOverride source)",
    );

    const incompatibleSchema = createStagedDefinition();
    delete incompatibleSchema.payloadChannelSpec.stages[1]!.literalOutput;
    incompatibleSchema.payloadChannelSpec.stages[1]!.minBytesOverride = {
      materializedParam: "selection",
      property: "placement",
      equals: "replace",
      minBytes: 7,
    };
    const responseFormat = incompatibleSchema.payloadChannelSpec.stages[0]!
      .responseFormat as { required: string[] };
    responseFormat.required = [];
    expect(() => parseToolDefinition(incompatibleSchema)).toThrow(
      "Invalid tool definition for staged_writer (payloadChannelSpec.stages.1.minBytesOverride schema)",
    );
  });

  test("preserves registry validation order", () => {
    const duplicate = createLookupModule("duplicate_lookup");
    expect(() =>
      buildToolRegistry([
        duplicate,
        {
          ...createLookupModule("duplicate_lookup"),
          implementation: undefined,
        } as unknown as ToolModuleDeclaration,
      ]),
    ).toThrow("Duplicate tool definition: duplicate_lookup");

    expect(() =>
      buildToolRegistry([
        {
          ...createLookupModule("invalid_implementation"),
          adapter: { normalizeCall: "invalid" },
          implementation: undefined,
        } as unknown as ToolModuleDeclaration,
      ]),
    ).toThrow(
      "Invalid tool module for invalid_implementation (implementation)",
    );

    expect(() =>
      buildToolRegistry([
        {
          ...createLookupModule("missing_invocation"),
          definition: {
            ...createLookupModule("missing_invocation").definition,
            params: { query: "string" },
          },
          normalInvocation: undefined,
        } as unknown as ToolModuleDeclaration,
      ]),
    ).toThrow(
      "Invalid tool module for missing_invocation (normalInvocation is required)",
    );
  });

  test("preserves declaration projection and callable identities", () => {
    const source = createLookupModule("projected_lookup");
    const normalizeCall = () => ({ tool: "projected_lookup", params: {} });
    const validateCall = () => null;
    const declaration: ToolModuleDeclaration = {
      ...source,
      definition: {
        ...source.definition,
        catalogGroups: undefined,
      },
      adapter: { normalizeCall, validateCall },
    };

    const [validated] = validateToolModuleDeclarations([declaration]);

    expect(validated?.definition).toEqual({
      name: "projected_lookup",
      description: "Look up host-owned information.",
      routingCapability: "semantic_lookup",
      catalogGroups: ["other"],
    });
    expect(validated?.definition).not.toHaveProperty("params");
    expect(validated?.definition).not.toHaveProperty("executionEffect");
    expect(validated?.implementation).toBe(declaration.implementation);
    expect(validated?.adapter?.normalizeCall).toBe(normalizeCall);
    expect(validated?.adapter?.validateCall).toBe(validateCall);
    expect(validated?.normalInvocation).toEqual(declaration.normalInvocation);
  });
});

function validStages(): Record<string, unknown>[] {
  return [
    {
      outputParam: "selection",
      responseFormat: {
        type: "object",
        properties: {
          placement: { type: "string", enum: ["replace", "delete"] },
        },
        required: ["placement"],
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
  ];
}

function createStagedDefinition(): MutableStagedDefinition {
  return {
    name: "staged_writer",
    routingCapability: "filesystem_mutation",
    params: { selection: "string", content: "string" },
    payloadChannelSpec: {
      params: ["selection", "content"],
      outputParam: "content",
      generationMode: "raw_text",
      stages: validStages(),
    },
  };
}

function createLookupModule(name: string): ToolModuleDeclaration {
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
    implementation: async ({ query }) => ({
      ok: true,
      output: `result:${String(query ?? "")}`,
      producedNewInformation: true,
    }),
  };
}
