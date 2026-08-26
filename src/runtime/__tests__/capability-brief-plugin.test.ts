import { describe, expect, test } from "vitest";

import createCapabilityBriefSource from "../../../plugins/capability-brief/source/index.js";
import type { ToolAvailabilityEntry } from "../../capabilities/tool-types.js";
import { createDefaultToolRegistry } from "../default-adapters.js";
import { loadBundledPluginEntrypoint } from "./public-plugin-test-support.js";
import { loadPublicRuntimeConfig } from "./public-runtime-config-fixture.js";

const AVAILABLE_TOOLS = Object.freeze([
  Object.freeze({
    toolName: "filesystem",
    operationId: "inspect_target",
    summary: "Inspect one bounded target.",
    catalogGroups: Object.freeze(["read"]),
    effect: "read_only" as const,
  }),
  Object.freeze({
    toolName: "filesystem",
    operationId: "write_complete_file",
    summary: "Write one complete file.",
    catalogGroups: Object.freeze(["write"]),
    effect: "mutating" as const,
  }),
]) satisfies readonly ToolAvailabilityEntry[];

describe("capability-brief plugin", () => {
  test("declares one on-demand read-only catalog operation", () => {
    const config = loadPublicRuntimeConfig(["capability-brief"]);
    const registry = createDefaultToolRegistry({
      ...config,
      plugins: { enabled: true, allow: ["capability-brief"] },
    });

    expect(registry.listDefinitions()).toEqual([
      expect.objectContaining({
        name: "capability_brief",
        routingCapability: "semantic_lookup",
        catalogGroups: ["available-agent-tools"],
      }),
    ]);
    expect(registry.listNormalInvocations?.()).toEqual([
      expect.objectContaining({
        toolName: "capability_brief",
        contract: {
          version: 1,
          operations: [
            expect.objectContaining({
              operationId: "describe_available_tools",
              effect: "read_only",
              approval: "request_policy",
              input: {
                type: "object",
                additionalProperties: false,
                properties: {},
                required: [],
              },
            }),
          ],
        },
      }),
    ]);
  });

  test("returns the request-effective brief only after invocation", async () => {
    const sourceHandler = createCapabilityBriefSource().handlers.capability_brief;
    const bundledHandler = loadBundledPluginEntrypoint<
      Readonly<Record<string, never>>,
      Readonly<{
        handlers: Readonly<{
          capability_brief: typeof sourceHandler;
        }>;
      }>
    >("capability-brief")({}).handlers.capability_brief;
    const executionContext = {
      sharedState: { availableTools: AVAILABLE_TOOLS },
    };

    const [sourceResult, bundledResult] = await Promise.all([
      sourceHandler({}, executionContext),
      bundledHandler({}, executionContext),
    ]);

    expect(sourceResult).toEqual(bundledResult);
    expect(sourceResult).toMatchObject({
      ok: true,
      producedNewInformation: true,
      data: {
        source: "request_effective_tool_registry",
        toolOperationCount: 2,
        observationMeta: { kind: "stable_fact", carryPolicy: "never" },
      },
    });
    expect(sourceResult.output).toContain("inspect_target");
    expect(sourceResult.output).toContain("write_complete_file");
    expect(sourceResult.output).not.toContain("input");
    expect(sourceResult.output).not.toContain("approval");
  });

  test("fails explicitly when the canonical projection is unavailable", async () => {
    const handler = createCapabilityBriefSource().handlers.capability_brief;

    await expect(handler({}, { sharedState: {} })).resolves.toMatchObject({
      ok: false,
      errorCode: "available_tool_catalog_unavailable",
      producedNewInformation: false,
    });
  });
});
