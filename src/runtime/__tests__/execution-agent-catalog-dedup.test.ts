import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import type { ToolModuleDeclaration } from "../../capabilities/tool-types.js";
import { successResult } from "../../plugin-sdk/index.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { handleRunRequest } from "../request/handler.js";
import {
  capsules,
  decision,
  filesystemScopeFixture,
  messages,
  type FilesystemModelInput,
} from "./support/filesystem-scope-integration-fixture.js";

const GROUP_KIND = "runtime_execution_capability_group_catalog_v1";
const ACTIVE_KIND = "runtime_execution_capability_catalog_v1";
const OBSERVE_SUMMARY =
  "Observe exactly one fixture item.\nPreserve this exact second line: itemId.";
const CHANGE_SUMMARY = "Change exactly one fixture item.";
const MIXED_SUMMARY = "Inspect and change one fixture item.";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

test("retains complete overlapping discovery and exact executable controls across closed, partial and full scopes", async () => {
  const fixture = await filesystemScopeFixture("execution-agent-v1");
  const observe = vi.fn<ToolModuleDeclaration["implementation"]>(async () =>
    successResult({ output: "Observed the selected fixture item." }),
  );
  const change = vi.fn<ToolModuleDeclaration["implementation"]>(async () =>
    successResult({ output: "Changed the selected fixture item." }),
  );
  const mixed = vi.fn<ToolModuleDeclaration["implementation"]>(async () =>
    successResult({ output: "Inspected and changed the fixture item." }),
  );
  const registry = createConfiguredToolRegistry(fixture.config, [
    moduleFor("inspect_and_change", ["omega"], MIXED_SUMMARY, "mixed", mixed),
    moduleFor(
      "observe_item",
      ["beta", "alpha"],
      OBSERVE_SUMMARY,
      "read_only",
      observe,
    ),
    moduleFor(
      "change_item",
      ["alpha", "beta"],
      CHANGE_SUMMARY,
      "mutating",
      change,
    ),
  ]);
  const prompt =
    "Observe observed-item, then change changed-item. Do not inspect or change any other item.";
  let decisionTurn = 0;
  const scripted = fixture.script(
    [
      {
        step: "execution.decision",
        output: decision({
          action: "open_capability_scope",
          catalogGroupIds: ["beta", "alpha"],
          acknowledgement: "I will observe and change the selected items.",
        }),
      },
      {
        step: "execution.decision",
        output: decision({
          action: "invoke_capability",
          capabilityId: "inspect_and_change",
          intent: "Attempt an unavailable capability.",
          selectionControls: { itemId: "outside-scope" },
          workingDirectory: ".",
        }),
      },
      {
        step: "execution.decision",
        output: decision({
          action: "invoke_capability",
          capabilityId: "observe_item",
          intent: "Observe the selected item.",
          selectionControls: { itemId: "observed-item" },
          workingDirectory: ".",
        }),
      },
      {
        step: "execution.decision",
        output: decision({
          action: "extend_capability_scope",
          catalogGroupIds: ["omega"],
        }),
      },
      {
        step: "execution.decision",
        output: decision({
          action: "invoke_capability",
          capabilityId: "change_item",
          intent: "Change the selected item.",
          selectionControls: { itemId: "changed-item" },
        }),
      },
      { step: "execution.decision", output: decision({ action: "respond" }) },
      {
        step: "execution.response",
        output: "Observed observed-item and changed changed-item.",
      },
    ],
    (input) => {
      if (input.modelStep !== "execution.decision") return;
      decisionTurn += 1;
      expect(
        messages(input).filter(
          (message) => message.role === "user" && message.content === prompt,
        ),
      ).toHaveLength(1);
      const groupCatalog = capsules(input, GROUP_KIND);
      expect(groupCatalog).toHaveLength(1);
      expect(groupCatalog[0]).toMatchObject({
        role: "user",
        authority: "runtime_registry",
        presenceEffect: "passive_routing_metadata_not_user_intent",
        catalogGroups: [
          {
            groupId: "alpha",
            description: `change_item: ${CHANGE_SUMMARY}\nobserve_item: ${OBSERVE_SUMMARY}`,
            memberCount: 2,
            effects: ["observation", "mutation"],
          },
          {
            groupId: "beta",
            description: "change_item\nobserve_item",
            memberCount: 2,
            effects: ["observation", "mutation"],
          },
          {
            groupId: "omega",
            description: `inspect_and_change: ${MIXED_SUMMARY}`,
            memberCount: 1,
            effects: ["mixed"],
          },
        ],
      });
      expect(groupCatalog[0]).not.toHaveProperty("groupDescriptionProjection");
      const activeCatalog = capsules(input, ACTIVE_KIND);
      const expectedActive =
        decisionTurn === 1
          ? []
          : [
              { capabilityId: "observe_item", effect: "observation" },
              { capabilityId: "change_item", effect: "mutation" },
              ...(decisionTurn >= 5
                ? [{ capabilityId: "inspect_and_change", effect: "mixed" }]
                : []),
            ];
      expect(activeCatalog).toHaveLength(decisionTurn === 1 ? 0 : 1);
      const active = activeCatalog[0]?.capabilities ?? [];
      expect(active).toEqual(expect.arrayContaining(expectedActive));
      expect(active).toHaveLength(expectedActive.length);
      const catalogText = JSON.stringify([groupCatalog, activeCatalog]);
      for (const summary of [OBSERVE_SUMMARY, CHANGE_SUMMARY, MIXED_SUMMARY]) {
        const encodedSummary = JSON.stringify(summary).slice(1, -1);
        expect(catalogText.split(encodedSummary)).toHaveLength(2);
      }

      const variants = invocationVariants(input);
      const offeredIds = variants.flatMap(
        ({ properties }) => properties.capabilityId.enum,
      );
      expect(offeredIds.sort()).toEqual(
        expectedActive.map(({ capabilityId }) => capabilityId).sort(),
      );
      for (const { properties } of variants) {
        expect(properties.selectionControls).toEqual({
          type: "object",
          additionalProperties: false,
          properties: {
            itemId: { type: "string", minLength: 1, maxLength: 80 },
          },
          required: ["itemId"],
        });
      }
      if (decisionTurn === 3) {
        expect(observe).not.toHaveBeenCalled();
        expect(change).not.toHaveBeenCalled();
        expect(mixed).not.toHaveBeenCalled();
      }
    },
  );
  try {
    await handleRunRequest(
      {
        send: (data: string) => fixture.events.push(JSON.parse(data)),
      } as unknown as WebSocket,
      {
        type: "run_request",
        requestId: "catalog-dedup-request",
        sessionId: "filesystem-session",
        input: prompt,
        agentMode: "reasoning",
        toolPermissionMode: "full_access",
        modelPreference: { profileId: "scripted", scope: "all" },
      },
      {
        runtimeConfig: fixture.config,
        sessionStore: fixture.sessions,
        toolRegistry: registry,
        modelGatewayClient: scripted.model,
        toolApprovalController: {
          requestToolApproval: async () => ({ approved: true }),
        },
      },
    );
    scripted.assertComplete();
    expect(decisionTurn).toBe(6);
    expect(observe).toHaveBeenCalledExactlyOnceWith(
      { itemId: "observed-item" },
      expect.anything(),
    );
    expect(change).toHaveBeenCalledExactlyOnceWith(
      { itemId: "changed-item" },
      expect.anything(),
    );
    expect(mixed).not.toHaveBeenCalled();
  } finally {
    await fixture.close();
  }
});

function moduleFor(
  operationId: string,
  catalogGroups: readonly string[],
  summary: string,
  effect: "read_only" | "mutating" | "mixed",
  implementation: ToolModuleDeclaration["implementation"],
): ToolModuleDeclaration {
  return {
    definition: {
      name: `${operationId}_fixture`,
      routingCapability:
        effect === "read_only" ? "semantic_lookup" : "semantic_mutation",
      catalogGroups: [...catalogGroups],
      controlsRefinement: "mechanical_when_complete",
    },
    normalInvocation: {
      version: 1,
      operations: [
        {
          operationId,
          summary,
          effect,
          approval: "request_policy",
          selectionControlIds: ["itemId"],
          input: {
            type: "object",
            additionalProperties: false,
            properties: {
              itemId: { type: "string", minLength: 1, maxLength: 80 },
            },
            required: ["itemId"],
          },
        },
      ],
    },
    implementation,
  };
}

type InvocationVariant = {
  properties: {
    action: { enum: string[] };
    capabilityId: { enum: string[] };
    selectionControls?: unknown;
  };
};

function invocationVariants(input: FilesystemModelInput): InvocationVariant[] {
  const format = input.format as {
    schema: {
      properties: {
        decision: InvocationVariant & { anyOf?: InvocationVariant[] };
      };
    };
  };
  const decisionSchema = format.schema.properties.decision;
  return (decisionSchema.anyOf ?? [decisionSchema]).filter(({ properties }) =>
    properties.action.enum.includes("invoke_capability"),
  );
}
