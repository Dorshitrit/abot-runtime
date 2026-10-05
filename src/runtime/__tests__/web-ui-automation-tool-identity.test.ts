import { describe, expect, it } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderAutomationEditor } from "../../web-ui/app/components/automations/editor.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderAutomationToolIdentity } from "../../web-ui/app/components/automations/tool-identity.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

const reference = { toolName: "web_search", operationId: "search_one", contractVersion: 2 };
const operation = { ...reference, label: "Search real public Internet domains and return matching pages for one query", pluginName: "web_research",
  toolDescription: "Find public sources", input: { properties: {}, required: [] } };
const node = { id: "gather", kind: "tool", title: "Collect material", operation: reference,
  controls: {}, onFailure: "stop" };

function parse(markup: string) {
  const document = {} as ConstructorParameters<typeof FakeElement>[1];
  document.createElement = (tag) => new FakeElement(tag, document);
  const root = document.createElement("section");
  root.innerHTML = markup;
  return root;
}

describe("automation configured tool identity", () => {
  it("keeps custom step title separate from the catalog tool and operation on the card and preview", () => {
    const root = parse(renderAutomationEditor({ automations: [], selectedAutomationId: "auto-one",
      selectedNodeId: "gather", runs: [], draft: { revision: 1, definition: {
        title: "Research", trigger: { kind: "manual" }, body: { kind: "sequence", id: "root", children: [node] },
      } }, catalog: { grantableOperations: [operation], operations: [], models: [], savedAgents: [] } }));
    const card = root.querySelector('[data-automation-node="gather"]')!;
    expect(card.querySelector("strong")!.textContent).toBe("Collect material");
    expect(card.querySelector(".automation-tool-identity-name")!.textContent).toBe("Web Search");
    expect(card.querySelector(".automation-tool-identity-operation")!.textContent).toBe("Search One");
    expect(card.querySelector(".automation-tool-identity")!.hasAttribute("aria-label")).toBe(false);
    const preview = root.querySelector(".automation-step-preview")!;
    expect(preview.querySelector(".automation-tool-identity-name")!.textContent).toBe("Web Search");
    expect(preview.querySelector(".automation-tool-identity-operation")!.textContent).toBe("Search One");
    expect(preview.querySelector(".automation-tool-identity-plugin")!.textContent).toBe("Web Research");
  });

  it("falls back to the configured reference when the operation catalog is missing", () => {
    const root = parse(renderAutomationToolIdentity(reference, null, { showPlugin: true }));
    expect(root.querySelector(".automation-tool-identity-name")!.textContent).toBe("Web Search");
    expect(root.querySelector(".automation-tool-identity-operation")!.textContent).toBe("Search One");
    expect(root.querySelector(".automation-tool-identity-plugin")).toBeNull();
    expect(root.querySelector(".automation-tool-identity")!.attributes.get("title")).toBe("web_search · search_one");
  });

  it("does not borrow metadata from a different contract revision or invent an unselected action", () => {
    const catalog = { operations: [{ ...operation, contractVersion: 3, pluginName: "different_plugin" }] };
    const stale = parse(renderAutomationToolIdentity(reference, catalog, { showPlugin: true }));
    expect(stale.querySelector(".automation-tool-identity-operation")!.textContent).toBe("Search One");
    expect(stale.querySelector(".automation-tool-identity-plugin")).toBeNull();
    const pending = parse(renderAutomationToolIdentity({ ...reference, operationId: "" }, catalog));
    expect(pending.querySelector(".automation-tool-identity-name")!.textContent).toBe("Web Search");
    expect(pending.querySelector(".automation-tool-identity-operation")!.textContent).toBe("Choose an operation");
  });

  it("escapes tool identity as text and excludes the descriptive summary from the identity", () => {
    const unsafe = { ...reference, toolName: '<script>alert("x")</script>', operationId: "<img src=x>" };
    const markup = renderAutomationToolIdentity(unsafe, { operations: [{ ...unsafe, label: "Long description" }] });
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("<img");
    expect(parse(markup).querySelector(".automation-tool-identity-operation")!.textContent).toBe("<img Src=x>");
    expect(markup).not.toContain("Long description");
  });
});
