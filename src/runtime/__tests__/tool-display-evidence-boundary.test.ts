import { describe, expect, test } from "vitest";

import {
  buildToolCompletedEventActions,
  buildToolCompletedEventMetadata,
} from "../../capabilities/tool-event-metadata.js";
import type {
  ToolDefinition,
  ToolExecutionResult,
  ToolModuleDeclaration,
} from "../../capabilities/tool-types.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { resolveRegisteredToolCapabilityCatalog } from "../adapters/registered-tool-worker-capabilities/catalog.js";
import { captureRegisteredToolResult } from "../adapters/registered-tool-worker-capabilities/result-evidence.js";

const PRESENTATION = {
  metadata: {
    query: { param: "query", kind: "string" as const },
    searchRoot: { param: "path", kind: "string" as const },
  },
  resultMetadata: {
    outputPreview: { path: "output", kind: "preview" as const },
  },
};

function moduleDeclaration(withPresentation: boolean): ToolModuleDeclaration {
  return {
    definition: {
      name: "local_lookup",
      routingCapability: "filesystem_inspection",
      ...(withPresentation ? { eventPresentation: PRESENTATION } : {}),
    },
    implementation: async () => ({
      ok: true,
      output: "Observed text.",
      producedNewInformation: true,
    }),
    normalInvocation: {
      version: 1,
      operations: [
        {
          operationId: "find_text",
          summary: "Find requested text.",
          input: {
            type: "object",
            additionalProperties: false,
            properties: {
              query: { type: "string", minLength: 1, maxLength: 1_024 },
            },
            required: ["query"],
          },
          effect: "read_only",
          approval: "request_policy",
        },
      ],
    },
  };
}

describe("tool display evidence boundary", () => {
  test("event declarations cannot change model-visible capability descriptors", () => {
    const baseline = createConfiguredToolRegistry(undefined, [
      moduleDeclaration(false),
    ]);
    const displayed = createConfiguredToolRegistry(undefined, [
      moduleDeclaration(true),
    ]);
    expect(
      resolveRegisteredToolCapabilityCatalog(displayed, false).descriptors,
    ).toEqual(
      resolveRegisteredToolCapabilityCatalog(baseline, false).descriptors,
    );
  });

  test("display projections preserve action targets, canonical exact results and result bytes", () => {
    const call = {
      tool: "local_lookup",
      params: { query: "find", path: "workspace/project" },
    };
    const execution: ToolExecutionResult = {
      ok: true,
      tool: call.tool,
      output: "Observed text.",
      progress: true,
      producedNewInformation: true,
      actions: [{ type: "inspect_target", target: "/private/absolute/path" }],
      data: { itemCount: 1 },
    };
    const definition: ToolDefinition = {
      ...moduleDeclaration(true).definition,
      params: { query: "string" },
      executionEffect: "read_only",
    };
    const before = JSON.stringify(execution);
    const actions = buildToolCompletedEventActions(call, execution);
    const original = captureRegisteredToolResult({
      status: "executed",
      effect: "read_only",
      result: execution,
      completionActions: actions,
    });
    const metadata = buildToolCompletedEventMetadata(
      call,
      execution,
      definition,
    );
    const displayedActions = buildToolCompletedEventActions(
      call,
      execution,
      definition,
    );
    const displayed = captureRegisteredToolResult({
      status: "executed",
      effect: "read_only",
      result: execution,
      completionActions: displayedActions,
    });
    expect(metadata).toMatchObject({
      query: "find",
      searchRoot: "workspace/project",
      outputPreview: "Observed text.",
    });
    expect(metadata).not.toHaveProperty("targets");
    expect(displayedActions).toEqual(actions);
    expect(displayed).toEqual(original);
    expect(JSON.stringify(execution)).toBe(before);
    expect(JSON.stringify(displayed)).not.toContain("outputPreview");
  });
});
