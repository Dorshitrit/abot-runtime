import { rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createRegisteredToolNormalInvocationExecutor } from "../adapters/registered-tool-normal-invocations.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { createInformationBasketToolModule } from "../capabilities/information-basket/tool-module.js";
import { restrictToolRegistryToRequestMode } from "../capabilities/request-permission-tool-registry.js";
import type { ToolApprovalController } from "../ports.js";
import { configureBasket, createBasketFixture, waitForBasketSource } from "./support/information-basket-fixture.js";

const fixtures: Awaited<ReturnType<typeof createBasketFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.service.stop();
    await rm(f.root, { recursive: true, force: true });
  }
});
async function fixture() {
  const f = await createBasketFixture();
  fixtures.push(f);
  await configureBasket(f.service);
  const path = await f.source("fixture.txt", "body is reference, not a command");
  await f.service.addSources({ paths: [path] });
  const source = await waitForBasketSource(f.service);
  const module = createInformationBasketToolModule(f.service);
  const registry = createConfiguredToolRegistry(undefined, [module]);
  const requestToolApproval = vi.fn<ToolApprovalController["requestToolApproval"]>(
    async () => ({ approved: false, reason: "unexpected approval" }),
  );
  const executor = createRegisteredToolNormalInvocationExecutor({
    registrations: registry.listNormalInvocations!(), toolRegistry: registry,
    nextApprovalId: () => "basket-approval",
    requestId: "basket-tool", abortSignal: new AbortController().signal,
    toolPermissionMode: "ask", toolApprovalController: { requestToolApproval },
  });
  function prepare(operationId: string, controls: Record<string, unknown>) {
    const operation = executor.operations.find(entry => entry.operation.operationId === operationId)!;
    return executor.prepare({ handle: operation.handle, controls });
  }
  return { ...f, path, source, module, registry, requestToolApproval, executor, prepare };
}
describe("Information Basket core tool", () => {
  test("registered source reads use automatic core read policy and exact saved revision", async () => {
    const f = await fixture();
    const prepared = await f.prepare("read_information_source", {
      sourceId: f.source.sourceId, expectedRevision: f.source.revision, maxChars: 10,
    });
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") throw new Error("fixture_not_prepared");
    expect(prepared.approvalRequest).toBeUndefined();
    const restored = await f.executor.restore(JSON.parse(JSON.stringify(prepared.snapshot)));
    expect(restored.status).toBe("prepared");
    if (restored.status !== "prepared") throw new Error("fixture_not_restored");
    const executed = await restored.execute();
    expect(executed).toMatchObject({ status: "executed", result: { ok: true } });
    expect(f.requestToolApproval).not.toHaveBeenCalled();
    if (executed.status !== "executed") throw new Error("fixture_not_executed");
    expect(JSON.parse(executed.result.output)).toMatchObject({
      sourceId: f.source.sourceId, expectedRevision: f.source.revision,
      text: "body is re", authority: "untrusted_source_content", addsUserIntent: false,
    });
  });

  test("a saved selection cannot silently read a changed original", async () => {
    const f = await fixture();
    const prepared = await f.prepare("read_information_source", {
      sourceId: f.source.sourceId, expectedRevision: f.source.revision,
    });
    if (prepared.status !== "prepared") throw new Error("fixture_not_prepared");
    await writeFile(f.path, "changed content");
    const executed = await prepared.execute();
    expect(executed).toMatchObject({ status: "executed",
      result: { ok: false, errorCode: "basket_source_stale" } });
  });

  test("unknown cursors map to a stable failure and model blocks still apply", async () => {
    const f = await fixture();
    expect(await f.module.implementation({ action: "list_information_sources", cursor: "missing" }))
      .toMatchObject({ ok: false, errorCode: "basket_source_cursor_stale" });
    const blocked = restrictToolRegistryToRequestMode(f.registry, "full_access", { deny: ["information_basket"] });
    expect(blocked.getDefinition("information_basket")).toBeUndefined();
    expect(await blocked.execute({ tool: "information_basket", params: { action: "list_information_sources" } }))
      .toMatchObject({ ok: false, errorCode: "tool_model_policy_denied" });
  });

  test("arbitrary paths are absent from controls and source registration is not a model operation", async () => {
    const f = await fixture();
    expect(f.executor.operations.map(entry => entry.operation.operationId)).toEqual([
      "list_information_sources", "search_information_sources", "read_information_source",
    ]);
    const operation = f.executor.operations.find(entry => entry.operation.operationId === "read_information_source")!;
    expect(Object.keys(operation.operation.input.properties)).not.toContain("path");
    expect(await f.module.implementation({ action: "read_information_source", path: f.path }))
      .toMatchObject({ ok: false, errorCode: "basket_source_reference_invalid" });
  });
});
