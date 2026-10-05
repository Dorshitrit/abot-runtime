import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  RegisteredToolNormalInvocation, ToolCall, ToolExecutionResult,
} from "../../capabilities/tool-types.js";
import { createAutomationDraftToolModule } from "../capabilities/automations/tool-module.js";
import { AUTOMATION_AUTHORING_REFERENCE } from "../capabilities/automation-builder/authoring-reference.js";
import { readAutomationAuthoringCatalogIndex, readAutomationAuthoringCatalogOperation } from "../capabilities/automations/authoring-catalog.js";
import { readAutomationAuthoringPreparation } from "../capabilities/automations/authoring-preparation.js";
import type { ToolRegistry } from "../ports.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";

type Fixture = Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>;
const fixtures: Fixture[] = [];
const readRef = { toolName: "catalog_read", operationId: "read", contractVersion: 1 } as const;
const plusRef = { toolName: "catalog_plus", operationId: "change", contractVersion: 1 } as const;

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

function registeredTool(ref: typeof readRef | typeof plusRef,
  permission: "full_access" | "full_plus"): RegisteredToolNormalInvocation {
  const mutating = permission === "full_plus";
  return {
    toolName: ref.toolName,
    definition: {
      name: ref.toolName,
      routingCapability: mutating ? "semantic_mutation" : "semantic_lookup",
      executionEffect: mutating ? "mutating" : "read_only",
      ...(mutating ? { requiredPermissionMode: "full_plus" as const } : {}),
      params: {},
    },
    contract: { version: 1, operations: [{
      operationId: ref.operationId,
      summary: mutating ? "Change one record" : "Read one record",
      effect: mutating ? "mutating" : "read_only",
      approval: "request_policy",
      fixedParams: { action: ref.operationId },
      input: { type: "object", additionalProperties: false, properties: {}, required: [] },
    }] },
  };
}

function toolFixture(includeOperations = true) {
  const registrations = includeOperations
    ? [registeredTool(readRef, "full_access"), registeredTool(plusRef, "full_plus")]
    : [];
  const execute = vi.fn(async (_call: ToolCall): Promise<ToolExecutionResult> => {
    throw new Error("unexpected_tool_execution");
  });
  const registry: ToolRegistry = {
    listDefinitions: () => registrations.map((item) => item.definition),
    listNormalInvocations: () => registrations,
    getDefinition: (name) => registrations.find((item) => item.toolName === name)?.definition,
    hasToolsAvailable: () => registrations.length > 0,
    getImplementations: () => ({}),
    execute,
  };
  return { registry, execute };
}

async function authoringCatalog(fixture: Fixture, automationId: string) {
  const studio = fixture.application.services.automations!;
  const module = createAutomationDraftToolModule(() => studio, async () => undefined);
  const result = await module.implementation({ action: "catalog", automationId });
  expect(result.ok).toBe(true);
  return JSON.parse(result.output) as {
    kind: string;
    grantsPermissions: boolean;
    catalogScope: unknown;
    permissions: unknown;
    operations: Record<string, unknown>[];
    grantedOperations: Record<string, unknown>[];
    models: { id: string }[];
    savedAgents: unknown[];
  };
}

describe("automation draft authoring catalog boundary", () => {
  it("offers both permission levels before a grant while publication remains user-gated", async () => {
    const tools = toolFixture();
    const fixture = await createSchedulerRuntimeFixture("execution-agent-v1", undefined, tools.registry);
    fixtures.push(fixture);
    const studio = fixture.application.services.automations!;
    const first = await studio.create("First draft");
    const initial = await authoringCatalog(fixture, first.automationId);

    expect(initial).toMatchObject({
      kind: "automation_authoring_catalog_v1", grantsPermissions: false,
      catalogScope: { kind: "automation", automationId: first.automationId },
      permissions: AUTOMATION_AUTHORING_REFERENCE.permissions,
      grantedOperations: [],
      models: [{ id: "scheduled-model" }], savedAgents: [],
    });
    expect(initial.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ ...readRef, permissionMode: "full_access" }),
      expect.objectContaining({ ...plusRef, permissionMode: "full_plus" }),
    ]));
    expect(initial.operations).toHaveLength(2);
    for (const operation of initial.operations) expect(operation).not.toHaveProperty("fixedParams");
    expect((await studio.catalog(first.automationId)).grantableOperations[0])
      .toHaveProperty("fixedParams", { action: "read" });
    expect(initial).not.toHaveProperty("grantableOperations");
    expect(await studio.getGrant(first.automationId)).toBeNull();
    expect(await fixture.scheduler.getAutomationJob(first.automationId)).toBeNull();

    const configured = await studio.updateDraft(first.automationId, first.revision, {
      kind: "add_node", parentSequenceId: first.definition.body.id, index: 0,
      nodeWithoutId: {
        kind: "tool", title: "Change record", onFailure: "stop",
        operation: plusRef, controls: {},
      },
    });
    expect(await studio.validate(first.automationId)).toEqual([]);
    await expect(studio.publish(first.automationId, configured.revision)).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: "automation_operation_unavailable" })]),
    });
    expect(await fixture.scheduler.getAutomationJob(first.automationId)).toBeNull();
    expect(await studio.getGrant(first.automationId)).toBeNull();

    await studio.replaceGrant({
      automationId: first.automationId, expectedGrantRevision: 0,
      mode: "full_plus", operations: [plusRef], actionId: "explicit-test-user-grant",
    });
    const afterGrant = await authoringCatalog(fixture, first.automationId);
    expect(afterGrant.operations).toHaveLength(2);
    expect(afterGrant.grantedOperations).toEqual([plusRef]);
    expect(afterGrant.grantedOperations[0]).toEqual({
      toolName: plusRef.toolName, operationId: plusRef.operationId,
      contractVersion: plusRef.contractVersion,
    });
    await studio.publish(first.automationId, configured.revision);
    expect(await fixture.scheduler.getAutomationJob(first.automationId)).not.toBeNull();

    const second = await studio.create("Independent draft");
    const otherCatalog = await authoringCatalog(fixture, second.automationId);
    expect(otherCatalog.catalogScope).toEqual({ kind: "automation", automationId: second.automationId });
    expect(otherCatalog.operations).toHaveLength(2);
    expect(otherCatalog.grantedOperations).toEqual([]);
    expect(await studio.getGrant(second.automationId)).toBeNull();
    const missing = await authoringCatalog(fixture, "requested-but-not-created");
    expect(missing.catalogScope).toEqual({ kind: "automation", automationId: "requested-but-not-created" });
    expect(missing.grantedOperations).toEqual([]);
    expect(missing.permissions).toEqual(initial.permissions);
    expect(await studio.getDraft("requested-but-not-created")).toBeNull();
    for (const automationId of [first.automationId, second.automationId, "requested-but-not-created", ""]) {
      const page = await readAutomationAuthoringCatalogIndex(studio, automationId, 0);
      const detail = await readAutomationAuthoringCatalogOperation(studio, automationId,
        plusRef.toolName, plusRef.operationId, plusRef.contractVersion);
      const ref = page.operations.items.find(({ toolName }) => toolName === plusRef.toolName)!.ref;
      const prepared = await readAutomationAuthoringPreparation(studio, {
        ...(automationId ? { automationId } : {}), operationRefs: [ref],
      });
      const expectedScope = automationId ? { kind: "automation", automationId } : { kind: "pre_draft" };
      expect(page.catalogScope).toEqual(expectedScope);
      expect(detail.catalogScope).toEqual(expectedScope);
      expect(prepared.catalogScope).toEqual(expectedScope);
      expect(detail.granted).toBe(automationId === first.automationId);
      expect(prepared.operations[0]?.granted).toBe(detail.granted);
      expect(page.operations.items.find(({ ref: candidate }) => candidate === ref)?.granted).toBe(detail.granted);
      expect(detail.operation.permissionMode).toBe("full_plus");
      expect(prepared.authoringReference.permissions).toEqual(page.permissions);
    }
    expect(tools.execute).not.toHaveBeenCalled();
    expect(fixture.invoke).not.toHaveBeenCalled();
    expect(fixture.invokeRaw).not.toHaveBeenCalled();
  });

  it("does not invent selectable actions when no tool is registered", async () => {
    const tools = toolFixture(false);
    const fixture = await createSchedulerRuntimeFixture("execution-agent-v1", undefined, tools.registry);
    fixtures.push(fixture);
    const studio = fixture.application.services.automations!;
    const draft = await studio.create("No tools");
    const catalog = await authoringCatalog(fixture, draft.automationId);
    expect(catalog.operations).toEqual([]);
    expect(catalog.grantedOperations).toEqual([]);
    expect(catalog.models).toEqual(expect.arrayContaining([expect.objectContaining({ id: "scheduled-model" })]));
    expect(catalog.savedAgents).toEqual([]);
    expect(await studio.getGrant(draft.automationId)).toBeNull();
    expect(tools.execute).not.toHaveBeenCalled();
    expect(fixture.invoke).not.toHaveBeenCalled();
  });
});
