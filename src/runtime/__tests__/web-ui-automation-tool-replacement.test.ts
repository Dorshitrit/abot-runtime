import { afterEach, expect, test, vi } from "vitest";
import { applyDraftMutation, createEmptyAutomationDefinition, parseDraftMutation } from "../automations/draft-mutations.js";
import type { ToolNode } from "../automations/definition-contracts.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { readAutomationNodePatch, renderAutomationNodeInspector, renderAutomationToolInputs, operationIdentity } from "../../web-ui/app/components/automations/node-inspector.js";

afterEach(() => vi.unstubAllGlobals());

function fixture(toolName = "removed_reader", contractVersion = 1) {
  const node: ToolNode = { kind: "tool", id: "preserved-node", title: "Read the source", onFailure: "stop",
    operation: { toolName, operationId: "read", contractVersion }, controls: {} };
  const available = [{ toolName: "new_reader", operationId: "read", contractVersion: 2,
    input: { properties: { source: { type: "string" } }, required: ["source"] } },
    { toolName: "other_reader", operationId: "read", contractVersion: 1, input: { properties: {} } }];
  const catalog = { operations: [], grantableOperations: available };
  const root = new FakeElement("div", {} as ConstructorParameters<typeof FakeElement>[1]);
  root.innerHTML = renderAutomationNodeInspector(node, catalog);
  const form = root.querySelector("form")!;
  vi.stubGlobal("FormData", class {
    constructor(private element: FakeElement) {}
    get(name: string) { return this.element.querySelector(`[name="${name}"]`)?.value ?? null; }
  });
  function defaults() {
    for (const select of form.querySelectorAll("select"))
      select.value = (select.querySelector("option[selected]") || select.querySelector("option"))?.value || "";
  }
  defaults();
  return { node, available, catalog, form, defaults };
}

test.each([["removed_reader", 1], ["new_reader", 1], ["new_reader", 2]] as const)(
  "offers replacement tools for %s contract %s, including grantable but not granted operations", (toolName, version) => {
    const f = fixture(toolName, version);
    const choices = f.form.querySelector('[name="toolOperation"]')!;
    const options = choices.querySelectorAll("option").filter((option) => option.value);
    expect(options.map((option) => option.textContent)).toEqual(["New Reader · Read", "Other Reader · Read"]);
    expect(options.map((option) => option.value)).toEqual(f.available.map(operationIdentity));
    const exact = toolName === "new_reader" && version === 2;
    expect(choices.value).toBe(exact ? operationIdentity(f.available[0]) : "");
  },
);

test("replacing a missing tool updates the existing node and preserves every downstream binding", () => {
  const f = fixture();
  f.form.querySelector("[data-automation-tool-inputs]")!.innerHTML = renderAutomationToolInputs(
    f.available[0], { source: { kind: "literal", value: "report.txt" } });
  f.defaults();
  f.form.querySelector('[name="toolOperation"]')!.value = operationIdentity(f.available[0]);
  const patch = readAutomationNodePatch(f.form, f.node, f.catalog);
  expect(patch.operation).toEqual({ toolName: "new_reader", operationId: "read", contractVersion: 2 });
  expect(patch.controls).toEqual({ source: { kind: "literal", value: "report.txt" } });
  const consumer: ToolNode = { ...f.node, id: "consumer", title: "Consume the result",
    controls: { source: { kind: "node_result", nodeId: f.node.id, select: "text" } } };
  const empty = createEmptyAutomationDefinition("automation", "Repair");
  const definition = { ...empty, body: { ...empty.body, children: [f.node, consumer] } };
  const updated = applyDraftMutation(definition, parseDraftMutation({ kind: "update_node", nodeId: f.node.id, patch }));
  expect(updated.body.children).toHaveLength(2);
  expect(updated.body.children[0]).toMatchObject({ id: f.node.id, operation: patch.operation });
  expect(updated.body.children[1]).toEqual(consumer);
});

test("refuses an unavailable or forged replacement without changing the saved node", () => {
  const f = fixture();
  const original = structuredClone(f.node);
  f.form.querySelector('[name="toolOperation"]')!.value = operationIdentity({ toolName: "forged", operationId: "read", contractVersion: 1 });
  expect(() => readAutomationNodePatch(f.form, f.node, f.catalog)).toThrow("Select an available operation");
  expect(f.node).toEqual(original);
});
