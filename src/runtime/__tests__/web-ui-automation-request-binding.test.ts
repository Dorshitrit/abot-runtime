import { afterEach, expect, test, vi } from "vitest";
import { FakeElement } from "./support/model-setup-wizard-harness.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderAutomationToolResults } from "../../web-ui/app/components/automations/editor.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { paletteNode } from "../../web-ui/app/components/automations/workspace.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { operationIdentity, readAutomationNodePatch, renderAutomationNodeInspector } from "../../web-ui/app/components/automations/node-inspector.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { matchesAutomationGrant, selectedAutomationOperations } from "../../web-ui/app/components/automations/permission-selection.js";
import { createAutomationRequests } from "../../web-ui/app/services/runtime-web-client/automations.js";

afterEach(() => vi.unstubAllGlobals());

const bound = { toolName: "custom_request_tool", operationId: "read", contractVersion: 1,
  requiresRequestBinding: true, label: "Read with request binding", permissionMode: "full_access",
  approval: "request_policy", input: { properties: {}, required: [] } };
const direct = { toolName: "system_command", operationId: "command", contractVersion: 1,
  label: "Run a command", permissionMode: "full_plus", approval: "request_policy",
  input: { properties: {}, required: [] } };
const catalog = { grantableOperations: [bound, direct], operations: [bound], models: [], savedAgents: [] };
const reference = ({ toolName, operationId, contractVersion }: typeof bound | typeof direct) =>
  ({ toolName, operationId, contractVersion });
const agent = { kind: "agent", id: "agent", title: "Read", onFailure: "stop", modelProfileId: "model",
  agentMode: "fast", roleInstructions: "", prompt: "Read", inputs: {},
  tools: [{ operation: reference(bound), usage: "required" }], result: { kind: "text" } };

test.each([catalog, { ...catalog, grantableOperations: undefined, operations: [bound, direct] }])(
  "standalone Tool palette excludes request-bound operations while preserving nondeclaring tools", (available) => {
    const markup = renderAutomationToolResults(available);
    expect(markup).not.toContain('data-palette-tool="custom_request_tool"');
    expect(markup).toContain('data-palette-tool="system_command"');
    expect(paletteNode({ kind: "tool", id: bound.toolName }, available)).toBeNull();
    expect(paletteNode({ kind: "tool", id: direct.toolName }, available)).toMatchObject({
      kind: "tool", operation: { toolName: direct.toolName },
    });
  });

test("editing an existing request-bound Tool requires replacement and rejects a forged selection", () => {
  const node = { kind: "tool", id: "read", title: "Read", onFailure: "stop",
    operation: reference(bound), controls: {} };
  const before = structuredClone(node);
  const root = new FakeElement("div", {} as ConstructorParameters<typeof FakeElement>[1]);
  root.innerHTML = renderAutomationNodeInspector(node, catalog);
  const form = root.querySelector("form")!;
  const select = form.querySelector('[name="toolOperation"]')!;
  expect(select.querySelectorAll("option").map((item) => item.value)).toEqual(["", operationIdentity(direct)]);
  expect(root.textContent).toContain("The saved operation is unavailable");
  vi.stubGlobal("FormData", class {
    constructor(private element: FakeElement) {}
    get(name: string) { return this.element.querySelector(`[name="${name}"]`)?.value ?? null; }
  });
  select.value = operationIdentity(bound);
  expect(() => readAutomationNodePatch(form, node, catalog)).toThrow("Select an available operation");
  expect(node).toEqual(before);
  select.value = operationIdentity(direct);
  expect(readAutomationNodePatch(form, node, catalog)).toMatchObject({ operation: reference(direct) });
});

test("Agent selection and grant confirmation retain request-bound operations", () => {
  const root = new FakeElement("div", {} as ConstructorParameters<typeof FakeElement>[1]);
  root.innerHTML = renderAutomationNodeInspector(agent, catalog);
  const selected = root.querySelectorAll("[data-agent-tool]").find((item) => item.dataset.agentTool === operationIdentity(bound));
  expect(selected?.hasAttribute("checked")).toBe(true);
  const selection = selectedAutomationOperations({ body: { kind: "sequence", children: [agent] } }, catalog);
  expect(selection).toMatchObject({ operations: [reference(bound)], missing: [], mode: "full_access" });
  expect(selection.details[0].requiresRequestBinding).toBe(true);
  expect(matchesAutomationGrant({ mode: "full_access", operations: [reference(bound)] }, selection)).toBe(true);
});

test("the WebUI catalog API preserves request-binding metadata while enriching model metadata", async () => {
  const requestApi = vi.fn(async (url: string) => url.startsWith("/chat/models")
    ? { profiles: [] } : { ok: true, ...catalog });
  const client = createAutomationRequests({ requestApi, getEnvironmentId: () => "dev", getConfig: () => ({ backend: "runtime" }) });
  const result = await client.getAutomationCatalog("automation");
  expect(result.grantableOperations).toEqual(catalog.grantableOperations);
  expect(result.operations).toEqual([bound]);
  expect(requestApi).toHaveBeenCalledTimes(2);
});
