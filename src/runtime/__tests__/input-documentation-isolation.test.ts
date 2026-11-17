import { describe, expect, test, vi } from "vitest";
import type {
  ToolModuleDeclaration,
  ToolNormalInvocationInput,
} from "../../capabilities/tool-types.js";
import type { RuntimeConfig } from "../ports.js";
import {
  readAutomationCatalog,
  type AutomationCatalogOperation,
} from "../automations/catalog.js";
import { fingerprintAutomationDependencies } from "../automations/dependency-fingerprint.js";
import { createEmptyAutomationDefinition } from "../automations/draft-mutations.js";
import type { AutomationPersistence } from "../automations/persistence.js";
import { emptyAutomationJournalState } from "../automations/storage-records.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import {
  homePlanFormat,
  parseHomePlan,
} from "../spark-home/generation/model-contracts.js";
import { createSparkHomeReadTools } from "../spark-home/generation/read-tools.js";

const operationRef = {
  toolName: "documented_web",
  operationId: "lookup",
  contractVersion: 1,
};
const config = {} as RuntimeConfig;

function inputSchema(
  documented: boolean,
  maxLength = 100,
): ToolNormalInvocationInput {
  return {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {
      query: {
        type: "string",
        minLength: 1,
        maxLength,
        ...(documented
          ? {
              description: "Filter entries; omit for all entries.",
              example: "release",
            }
          : {}),
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 10,
        ...(documented
          ? { description: "Maximum number of returned entries.", example: 5 }
          : {}),
      },
    },
  };
}

function toolModule(documented: boolean): ToolModuleDeclaration {
  return {
    definition: {
      name: operationRef.toolName,
      description: "Read entries.",
      routingCapability: "web_lookup",
      catalogGroups: ["web"],
    },
    normalInvocation: {
      version: 1,
      operations: [
        {
          operationId: operationRef.operationId,
          summary: "Read entries.",
          input: inputSchema(documented),
          effect: "read_only",
          approval: "request_policy",
        },
      ],
    },
    implementation: vi.fn(async () => ({ ok: true, output: "unused", producedNewInformation: false })),
  };
}

function catalogPersistence(): AutomationPersistence {
  const state = emptyAutomationJournalState();
  state.grants.push({
    id: "grant",
    environmentId: "test",
    automationId: "automation",
    grantRevision: 1,
    mode: "full_access",
    operations: [operationRef],
    evidence: {
      kind: "authenticated_user_action",
      actionId: "action",
      at: "2026-11-15T00:00:00Z",
    },
  });
  return {
    read: async () => state,
    update: async () => {
      throw new Error("unexpected persistence mutation");
    },
    updateWithScheduler: async () => {
      throw new Error("unexpected persistence mutation");
    },
  };
}

describe("plugin argument documentation stays outside non-SUPER consumers", () => {
  test("automation catalogs remain structurally identical with documentation", async () => {
    const plain = toolModule(false);
    const documented = toolModule(true);
    const registry = createConfiguredToolRegistry(undefined, [documented]);
    const read = (tools: ReturnType<typeof createConfiguredToolRegistry>) =>
      readAutomationCatalog({
        automationId: "automation",
        environmentId: "test",
        config,
        tools,
        persistence: catalogPersistence(),
      });
    const baseline = await read(
      createConfiguredToolRegistry(undefined, [plain]),
    );
    const enriched = await read(registry);
    expect(enriched.operations).toHaveLength(1);
    expect(enriched.grantableOperations).toHaveLength(1);
    expect(enriched).toEqual(baseline);
    expect(enriched.operations[0]!.input).toEqual(inputSchema(false));
    expect(
      registry.listNormalInvocations!()[0]!.contract.operations[0]!.input
        .properties.query,
    ).toHaveProperty("description", "Filter entries; omit for all entries.");
    expect(plain.implementation).not.toHaveBeenCalled();
    expect(documented.implementation).not.toHaveBeenCalled();
  });

  test("documentation does not invalidate automation dependencies, but structural constraints do", () => {
    const draft = createEmptyAutomationDefinition("automation", "Read entries");
    const definition = {
      ...draft,
      body: {
        ...draft.body,
        children: [
          {
            id: "read",
            title: "Read",
            kind: "tool" as const,
            onFailure: "stop" as const,
            operation: operationRef,
            controls: {},
          },
        ],
      },
    };
    const catalog: AutomationCatalogOperation = {
      ...operationRef,
      label: "Read entries",
      permissionMode: "full_access",
      catalogGroups: ["web"],
      effect: "read_only",
      approval: "request_policy",
      input: inputSchema(false),
    };
    const fingerprint = (input: ToolNormalInvocationInput) =>
      fingerprintAutomationDependencies({
        definition,
        config,
        operations: [{ ...catalog, input }],
      });
    expect(fingerprint(inputSchema(true))).toBe(
      fingerprint(inputSchema(false)),
    );
    const revisedDocumentation = inputSchema(true);
    const changedCopy = {
      ...revisedDocumentation,
      properties: {
        ...revisedDocumentation.properties,
        query: {
          ...revisedDocumentation.properties.query!,
          description: "Different explanation.",
          example: "different",
        },
      },
    };
    expect(fingerprint(changedCopy)).toBe(fingerprint(inputSchema(false)));
    expect(fingerprint(inputSchema(true, 101))).not.toBe(
      fingerprint(inputSchema(false)),
    );
  });

  test("SPARK read descriptors, provider format, and optional omission remain unchanged", async () => {
    const plain = toolModule(false);
    const documented = toolModule(true);
    const prepare = (module: ToolModuleDeclaration) =>
      createSparkHomeReadTools({
        registry: createConfiguredToolRegistry(undefined, [module]),
        runId: "documentation-isolation",
        signal: new AbortController().signal,
        mode: "full_access",
        approvals: { requestToolApproval: vi.fn() },
      });
    const baseline = await prepare(plain);
    const enriched = await prepare(documented);
    try {
      expect(enriched.descriptors).toHaveLength(1);
      expect(enriched.descriptors).toEqual(baseline.descriptors);
      expect(enriched.planning()).toEqual(baseline.planning());
      expect(homePlanFormat(enriched.descriptors)).toEqual(
        homePlanFormat(baseline.descriptors),
      );
      const plan = JSON.stringify({
        direction: "Read all entries",
        reads: [
          {
            operation: "documented_web:lookup",
            purpose: "Inspect",
            controls: { query: null, limit: null },
          },
        ],
      });
      expect(parseHomePlan(plan, enriched.descriptors)).toEqual(
        parseHomePlan(plan, baseline.descriptors),
      );
      expect(
        parseHomePlan(plan, enriched.descriptors).reads[0]!.controls,
      ).toEqual({});
      expect(plain.implementation).not.toHaveBeenCalled();
      expect(documented.implementation).not.toHaveBeenCalled();
    } finally {
      await enriched.dispose();
      await baseline.dispose();
    }
  });
});
