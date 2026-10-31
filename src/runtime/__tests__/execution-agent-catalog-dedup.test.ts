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
import { EXECUTION_CAPABILITY_GROUP_CATALOG_HEADER as GROUP_HEADER } from "../steps/execution-agent/state-context.js";
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
afterEach(() => {
  resetDebugLoggerConfig();
  vi.useRealTimers();
});

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
        }),
      },
      {
        step: "execution.decision",
        output: decision({
          action: "invoke_capability",
          capabilityId: "inspect_and_change",
          selectionControls: { itemId: "outside-scope" },
          workingDirectory: ".",
        }),
      },
      {
        step: "execution.decision",
        output: decision({
          action: "invoke_capability",
          capabilityId: "observe_item",
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
      expect(capsules(input, GROUP_KIND)).toEqual([]);
      expect(
        messages(input).filter(({ content }) =>
          content.startsWith(GROUP_HEADER),
        ),
      ).toEqual([
        { role: "user", content: `${GROUP_HEADER} alpha: change_item_fixture, observe_item_fixture | beta: change_item_fixture, observe_item_fixture | omega: inspect_and_change_fixture` },
      ]);
      const offeredGroups = decisionVariants(input).flatMap(
        ({ properties }) => properties.catalogGroupIds?.items.enum ?? [],
      );
      expect(offeredGroups).toEqual(
        [["alpha", "beta", "omega"], ["omega"], ["omega"], ["omega"], [], []][
          decisionTurn - 1
        ],
      );
      const activeCatalog = capsules(input, ACTIVE_KIND);
      const expectedActive =
        decisionTurn === 1
          ? []
          : [
              {
                capabilityId: "observe_item",
                effect: "observation",
                summary: OBSERVE_SUMMARY,
              },
              {
                capabilityId: "change_item",
                effect: "mutation",
                summary: CHANGE_SUMMARY,
              },
              ...(decisionTurn >= 5
                ? [
                    {
                      capabilityId: "inspect_and_change",
                      effect: "mixed",
                      summary: MIXED_SUMMARY,
                    },
                  ]
                : []),
            ];
      expect(activeCatalog).toHaveLength(decisionTurn === 1 ? 0 : 1);
      const active = activeCatalog[0]?.capabilities ?? [];
      expect(active).toEqual(expect.arrayContaining(expectedActive));
      expect(active).toHaveLength(expectedActive.length);
      const catalogText = messages(input)
        .map(({ content }) => content)
        .join("\n");
      for (const summary of [OBSERVE_SUMMARY, CHANGE_SUMMARY, MIXED_SUMMARY]) {
        const encodedSummary = JSON.stringify(summary).slice(1, -1);
        const expectedCount = expectedActive.some(
          (entry) => entry.summary === summary,
        )
          ? 1
          : 0;
        expect(catalogText.split(encodedSummary)).toHaveLength(
          expectedCount + 1,
        );
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

test("a greeting receives the same closed catalog with one or 32 operations in one tool", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-13T00:00:00.000Z"));
  const projections: unknown[] = [];
  for (const operationCount of [1, 32]) {
    const fixture = await filesystemScopeFixture("execution-agent-v1");
    const execute = vi.fn<ToolModuleDeclaration["implementation"]>(async () =>
      successResult({ output: "Unexpected execution." }),
    );
    const operationModules = Array.from({ length: operationCount }, (_, index) =>
      moduleFor(
        `operation_${index}`,
        ["dynamic_group"],
        `Summary ${index}.`,
        "read_only",
        execute,
      ),
    );
    const first = operationModules[0]!;
    const module: ToolModuleDeclaration = {
      ...first,
      definition: { ...first.definition, name: "dynamic_fixture" },
      normalInvocation: {
        version: 1,
        operations: operationModules.flatMap((item) => item.normalInvocation!.operations),
      },
    };
    const registry = createConfiguredToolRegistry(fixture.config, [module]);
    const inputs: FilesystemModelInput[] = [];
    const scripted = fixture.script(
      [
        {
          step: "execution.decision",
          output: decision({ action: "respond" }),
        },
        { step: "execution.response", output: "Hello." },
      ],
      (input) => inputs.push(input),
    );
    try {
      await handleRunRequest(
        {
          send: (data: string) => fixture.events.push(JSON.parse(data)),
        } as unknown as WebSocket,
        {
          type: "run_request",
          requestId: "greeting-catalog-request",
          sessionId: "filesystem-session",
          input: "Hi",
          agentMode: "reasoning",
          toolPermissionMode: "full_access",
          modelPreference: { profileId: "scripted", scope: "all" },
        },
        {
          runtimeConfig: fixture.config,
          sessionStore: fixture.sessions,
          toolRegistry: registry,
          modelGatewayClient: scripted.model,
        },
      );
      scripted.assertComplete();
      const initial = inputs[0]!;
      expect(capsules(initial, GROUP_KIND)).toEqual([]);
      expect(
        messages(initial).filter(({ content }) =>
          content.startsWith(GROUP_HEADER),
        ),
      ).toEqual([{ role: "user", content: `${GROUP_HEADER} dynamic_group: dynamic_fixture` }]);
      expect(
        decisionVariants(initial).flatMap(
          ({ properties }) => properties.catalogGroupIds?.items.enum ?? [],
        ),
      ).toEqual(["dynamic_group"]);
      expect(invocationVariants(initial)).toEqual([]);
      expect(capsules(initial, ACTIVE_KIND)).toEqual([]);
      expect(
        messages(initial).filter(
          ({ role, content }) => role === "user" && content === "Hi",
        ),
      ).toHaveLength(1);
      for (const input of inputs) {
        const exposed = JSON.stringify({
          messages: messages(input),
          format: input.format,
        });
        for (const operation of module.normalInvocation!.operations) {
          expect(exposed).not.toContain(operation.operationId);
          expect(exposed).not.toContain(operation.summary);
        }
        expect(exposed).not.toContain("itemId");
      }
      projections.push(
        inputs.map((input) => ({
          messages: messages(input),
          schema: input.format,
        })),
      );
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  }
  expect(projections[0]).toEqual(projections[1]);
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
    catalogGroupIds?: { items: { enum: string[] } };
  };
};

function decisionVariants(input: FilesystemModelInput): InvocationVariant[] {
  const format = input.format as {
    schema: {
      properties: {
        decision: InvocationVariant & { anyOf?: InvocationVariant[] };
      };
    };
  };
  const decisionSchema = format.schema.properties.decision;
  return decisionSchema.anyOf ?? [decisionSchema];
}

function invocationVariants(input: FilesystemModelInput): InvocationVariant[] {
  return decisionVariants(input).filter(({ properties }) =>
    properties.action.enum.includes("invoke_capability"),
  );
}
