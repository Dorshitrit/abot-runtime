import { afterEach, expect, test, vi } from "vitest";
import type { RegisteredToolNormalInvocation } from "../../capabilities/tool-types.js";
import type { ToolRegistry } from "../ports.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";

const fixtures: Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

test("publication pins fixed parameters and rejects changed behavior at normal and replay admission", async () => {
  const operation = { toolName: "record_writer", operationId: "write", contractVersion: 1 };
  let fixedAction = "create";
  const registration = (): RegisteredToolNormalInvocation => ({
    toolName: operation.toolName,
    definition: { name: operation.toolName, routingCapability: "semantic_mutation",
      executionEffect: "mutating", params: { action: "string" } },
    contract: { version: 1, operations: [{
      operationId: operation.operationId, summary: "Write a record", effect: "mutating",
      approval: "request_policy", fixedParams: { action: fixedAction },
      input: { type: "object", additionalProperties: false, properties: {}, required: [] },
    }] },
  });
  const execute = vi.fn(async () => ({ ok: true, tool: operation.toolName,
    output: "Recorded", producedNewInformation: true }));
  const tools: ToolRegistry = {
    listDefinitions: () => [registration().definition], listNormalInvocations: () => [registration()],
    getDefinition: () => registration().definition, hasToolsAvailable: () => true,
    getImplementations: () => ({}), execute,
  };
  const fixture = await createSchedulerRuntimeFixture("execution-agent-v1", undefined, tools);
  fixtures.push(fixture);
  const studio = fixture.application.services.automations!;
  const created = await studio.create("Pinned writer");
  await studio.replaceGrant({ automationId: created.automationId, expectedGrantRevision: 0,
    mode: "full_access", operations: [operation], actionId: "explicit-test-grant" });
  const draft = await studio.updateDraft(created.automationId, created.revision, {
    kind: "add_node", parentSequenceId: created.definition.body.id, index: 0,
    nodeWithoutId: { kind: "tool", title: "Write", onFailure: "stop", operation, controls: {} },
  });
  await studio.publish(created.automationId, draft.revision);
  const first = await studio.runNow(created.automationId);
  await expect.poll(async () => (await studio.getRun(first.id)).status,
    { timeout: 8_000, interval: 10 }).toBe("succeeded");
  expect(execute).toHaveBeenCalledOnce();

  fixedAction = "delete";
  const changed = await studio.runNow(created.automationId);
  await expect.poll(async () => (await studio.getRun(changed.id)).status,
    { timeout: 8_000, interval: 10 }).toBe("failed");
  expect(await studio.getRun(changed.id)).toMatchObject({ error: "automation_contract_changed" });
  await expect(studio.rerun(first.id, "repeat-after-contract-change", true))
    .rejects.toThrow("automation_contract_changed");
  expect(execute).toHaveBeenCalledOnce();
  expect(fixture.invoke).not.toHaveBeenCalled();

  const catalog = await studio.catalog(created.automationId);
  expect(catalog.operations[0]).toMatchObject({ ...operation, fixedParams: { action: "delete" } });
});
