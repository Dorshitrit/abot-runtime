import { describe, expect, test } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { listAvailableAutomationProducers } from "../../web-ui/app/lib/automation-binding-producers.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { readBindingFields, renderBindingFields, renderBindingRow } from "../../web-ui/app/components/automations/binding-fields.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderAutomationNodeInspector } from "../../web-ui/app/components/automations/node-inspector.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createAutomationsWorkspace } from "../../web-ui/app/components/automations/workspace.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { changeAutomationBindingKind, handleAutomationBindingClick } from "../../web-ui/app/components/automations/binding-editor.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

const step = (id: string, title: string, kind = "agent") => ({
  id, title, kind,
  ...(kind === "tool" ? {
    operation: { toolName: "fixture", operationId: "read", contractVersion: 1 }, controls: {},
  } : {}),
});
const sequence = (id: string, children: object[]) => ({ kind: "sequence", id, children });
const graph = sequence("root", [
  step("source", "Read source", "tool"),
  { kind: "parallel", id: "reviews", branches: [
    sequence("left", [step("left-first", "Left first"), step("left-target", "Left target")]),
    sequence("right", [step("right-first", "Right first", "tool")]),
  ] },
  step("joined", "Combine reviews"),
]);

describe("ABot Studio earlier-step bindings", () => {
  test("offers only producers settled on the selected branch, then all branches after join", () => {
    expect(listAvailableAutomationProducers(graph, "left-target").map((item: { id: string }) => item.id))
      .toEqual(["source", "left-first"]);
    expect(listAvailableAutomationProducers(graph, "right-first").map((item: { id: string }) => item.id))
      .toEqual(["source"]);
    expect(listAvailableAutomationProducers(graph, "joined").map((item: { id: string }) => item.id))
      .toEqual(["source", "left-first", "left-target", "right-first", "reviews"]);
    expect(listAvailableAutomationProducers(graph, "source")).toEqual([]);
    const nested = sequence("nested-root", [{ kind: "parallel", id: "outer", branches: [
      sequence("outer-left", [{ kind: "parallel", id: "inner", branches: [
        sequence("inner-left", [step("inner-a", "Inner A")]),
        sequence("inner-right", [step("inner-b", "Inner B")]),
      ] }, step("after-inner", "After inner")]),
      sequence("outer-right", [step("outer-b", "Outer B")]),
    ] }, step("after-outer", "After outer")]);
    expect(listAvailableAutomationProducers(nested, "after-inner").map((item: { id: string }) => item.id))
      .toEqual(["inner-a", "inner-b", "inner"]);
    expect(listAvailableAutomationProducers(nested, "after-outer").map((item: { id: string }) => item.id))
      .toEqual(["inner-a", "inner-b", "inner", "after-inner", "outer-b", "outer"]);
    expect(listAvailableAutomationProducers(nested, "outer-b").map((item: { id: string }) => item.id))
      .toEqual([]);
  });

  test("shows human-readable step choices while storing a stable producer ID", () => {
    const producers = listAvailableAutomationProducers(graph, "left-target");
    const markup = renderBindingRow("material", {
      kind: "node_result", nodeId: "source", select: "text",
    }, { producers });
    expect(markup).toContain('data-binding-value aria-label="Source step"');
    expect(markup).toContain('<option value="source" selected>Read source · source</option>');
    expect(markup).not.toContain('value="right-first"');
    expect(markup).not.toContain('value="reviews"');
    expect(markup).not.toContain("Literal type<select");

    const controls = new Map([
      ["[data-binding-key]", { value: "material" }],
      ["[data-binding-kind]", { value: "node_result" }],
      ["[data-binding-value]", { value: "source" }],
      ["[data-binding-output]", { value: "text" }],
    ]);
    const row = { querySelector: (selector: string) => controls.get(selector) ?? null };
    const fieldset = { querySelectorAll: () => [row] };
    const form = { querySelector: (selector: string) => selector === '[data-binding-fields="inputs"]' ? fieldset : null };
    expect(readBindingFields(form, "inputs")).toEqual({
      material: { kind: "node_result", nodeId: "source", select: "text" },
    });
  });

  test("offers completed parallel groups by name and retains unavailable group bindings", () => {
    const beforeJoin = listAvailableAutomationProducers(graph, "left-target");
    const afterJoin = listAvailableAutomationProducers(graph, "joined");
    const early = renderBindingRow("reviews", {
      kind: "branch_results", parallelNodeId: "reviews",
    }, { producers: beforeJoin });
    expect(early).toContain("Unavailable parallel group · reviews");
    const joined = renderBindingRow("reviews", {
      kind: "branch_results", parallelNodeId: "reviews",
    }, { producers: afterJoin });
    expect(joined).toContain('<option value="reviews" selected>Parallel · 2 branches · reviews</option>');
    expect(joined).not.toContain("Unavailable parallel group");
    expect(renderBindingRow("source", { kind: "node_result", nodeId: "reviews", select: "text" },
      { producers: afterJoin })).toContain("Unavailable step · reviews");
    expect(renderBindingRow("reviews", { kind: "branch_results", parallelNodeId: "missing" },
      { producers: afterJoin })).toContain("Unavailable parallel group · missing");
  });

  test("connect output creates a parallel binding only for an eligible completed group", () => {
    const producers = listAvailableAutomationProducers(graph, "joined");
    let inserted = "";
    const source = { value: "reviews" };
    const fields = {
      querySelector: (selector: string) => selector === "[data-connect-result-source]" ? source : {},
      querySelectorAll: () => [],
      insertBefore: (row: { markup: string }) => { inserted = row.markup; },
      closest: () => null,
    };
    const button = { dataset: { addResultBinding: "" }, closest: () => fields };
    const documentRoot = { createElement: () => ({
      innerHTML: "",
      get firstElementChild() { return {
        markup: this.innerHTML,
        querySelector: () => ({ focus() {} }),
      }; },
    }) };
    expect(handleAutomationBindingClick(button, producers, documentRoot)).toBe(true);
    expect(inserted).toContain('data-binding-current-kind="branch_results"');
    expect(inserted).toContain('<option value="reviews" selected>Parallel · 2 branches · reviews</option>');
  });

  test("switching back to Literal restores freeform type and value but keeps schema types fixed", () => {
    function changedMarkup(schemaType: string, drafts: object) {
      let markup = "";
      const controls = new Map([
        ["[data-binding-value]", { value: "source" }],
        ["[data-binding-key]", { value: "material" }],
        ["[data-binding-literal-type]", { value: "string" }],
        ["[data-binding-output]", { value: "text" }],
      ]);
      const row = {
        dataset: { bindingCurrentKind: "node_result", bindingSchemaType: schemaType,
          bindingRequired: String(Boolean(schemaType)), bindingDrafts: JSON.stringify(drafts) },
        querySelector: (selector: string) => controls.get(selector) ?? null,
        replaceWith: (replacement: { markup: string }) => { markup = replacement.markup; },
      };
      const selector = { value: "literal", closest: () => row };
      const documentRoot = { createElement: () => ({
        innerHTML: "",
        get firstElementChild() { return { markup: this.innerHTML, closest: () => null }; },
      }) };
      changeAutomationBindingKind(selector, [], documentRoot);
      return markup;
    }
    const freeform = changedMarkup("", { literal: { value: "42", literalType: "number" } });
    expect(freeform).toContain('value="42"');
    expect(freeform).toContain('Literal type<select data-binding-literal-type>');
    expect(freeform).toContain('<option value="number" selected>Number</option>');
    const required = changedMarkup("integer", { literal: { value: "42", literalType: "integer" } });
    expect(required).toContain('type="hidden" data-binding-literal-type value="integer"');
    expect(required).toContain('<span class="automation-required">Required</span>');
    expect(required).not.toContain("Literal type<select");
  });

  test("changing a Literal to a result requires an explicit producer choice", () => {
    const controls = new Map([
      ["[data-binding-value]", { value: "source" }],
      ["[data-binding-key]", { value: "material" }],
      ["[data-binding-literal-type]", { value: "string" }],
    ]);
    const row = {
      dataset: { bindingCurrentKind: "literal", bindingSchemaType: "",
        bindingRequired: "false", bindingDrafts: "{}" },
      querySelector: (selector: string) => controls.get(selector) ?? null,
      replaceWith(replacement: { markup: string }) { markup = replacement.markup; },
    };
    const documentRoot = { createElement: () => ({
      innerHTML: "",
      get firstElementChild() { return { markup: this.innerHTML, closest: () => null }; },
    }) };
    const producers = listAvailableAutomationProducers(graph, "joined");
    let markup = "";
    changeAutomationBindingKind({ value: "node_result", closest: () => row }, producers, documentRoot);
    expect(markup).toContain('<option value="" selected>Choose an earlier step</option>');
    expect(markup).not.toContain('<option value="source" selected>');
    changeAutomationBindingKind({ value: "branch_results", closest: () => row }, producers, documentRoot);
    expect(markup).toContain('<option value="" selected>Choose a completed parallel group</option>');
    expect(markup).not.toContain('<option value="reviews" selected>');
  });

  test("offers a per-run file path without replacing the explicit step or literal bindings", () => {
    const markup = renderBindingRow("output", { kind: "run_file", fileName: "report.md" });
    expect(markup).toContain('<option value="run_file" selected>New file for this run</option>');
    expect(markup).toContain('aria-label="File name"');
    expect(markup).toContain('value="report.md"');
    expect(markup).toContain("Each run gets its own folder");
    const row = { querySelector: (selector: string) => ({
      "[data-binding-key]": { value: "output" },
      "[data-binding-kind]": { value: "run_file" },
      "[data-binding-value]": { value: "report.md" },
    } as Record<string, object>)[selector] || null };
    const form = { querySelector: () => ({ querySelectorAll: () => [row] }) };
    expect(readBindingFields(form, "controls")).toEqual({
      output: { kind: "run_file", fileName: "report.md" },
    });
  });

  test("keeps Agent-only sources out of Tool inputs while showing stale saved sources", () => {
    const fresh = renderBindingFields({ output: { kind: "literal", value: "" } }, {
      properties: { output: { type: "string" } }, required: ["output"],
    }, { name: "controls" });
    expect(fresh).not.toContain('<option value="branch_results"');
    expect(fresh).not.toContain('<option value="source_files"');
    expect(fresh).toContain('<option value="run_file"');
    const stale = renderBindingFields({ output: { kind: "branch_results", parallelNodeId: "old" } }, {
      properties: { output: { type: "string" } },
    }, { name: "controls" });
    expect(stale).toContain('<option value="branch_results" selected>Parallel results · unavailable for tool inputs</option>');
    expect(stale).toContain("This saved source cannot be used by a tool input");
    const agent = renderBindingFields({ output: { kind: "literal", value: "" } }, null, { name: "inputs" });
    expect(agent).toContain('<option value="branch_results"');
    expect(agent).toContain('<option value="source_files"');
  });

  test("keeps a broken link visible and distinguishes an independent Agent from an error", () => {
    const producers = listAvailableAutomationProducers(graph, "joined");
    const stale = renderBindingRow("material", {
      kind: "node_result", nodeId: "removed-step", select: "text",
    }, { producers });
    expect(stale).toContain('<option value="removed-step" selected>Unavailable step · removed-step</option>');
    expect(stale).toContain("no longer available before the current step");

    const agent = {
      kind: "agent", id: "joined", title: "Combine reviews", modelProfileId: "local",
      agentMode: "fast", onFailure: "stop", prompt: "Combine", roleInstructions: "",
      inputs: {}, tools: [], result: { kind: "text" },
    };
    const independent = renderAutomationNodeInspector(agent, { operations: [], models: [] }, null, producers);
    expect(independent).toContain('data-input-connection="none"');
    expect(independent).toContain('data-connect-result-source');
    expect(independent).not.toContain("automation-node-error");
    const linked = renderAutomationNodeInspector({ ...agent, inputs: {
      source: { kind: "node_result", nodeId: "source", select: "text" },
    } }, { operations: [], models: [] }, null, producers);
    expect(linked).not.toContain('data-input-connection="none"');
    const moved = sequence("moved", [agent, step("source", "Read source", "tool")]);
    const forwardReference = renderBindingRow("source", {
      kind: "node_result", nodeId: "source", select: "text",
    }, { producers: listAvailableAutomationProducers(moved, "joined") });
    expect(forwardReference).toContain("Unavailable step · source");
  });

  test("passes graph-scoped producer choices from the workspace to the modal editor", () => {
    const target = {
      kind: "agent", id: "target", title: "Review", modelProfileId: "local",
      agentMode: "fast", onFailure: "stop", prompt: "Review", roleInstructions: "",
      inputs: { material: { kind: "node_result", nodeId: "source", select: "text" } },
      tools: [], result: { kind: "text" },
    };
    const definition = {
      schemaVersion: 1, automationId: "automation-one", revision: 1, title: "Review source",
      objective: "", inputs: {}, trigger: { kind: "manual" }, limits: {},
      body: sequence("root", [step("source", "Read source", "tool"), target, step("later", "Later step")]),
    };
    const snapshot = {
      automations: [], selectedAutomationId: "automation-one", selectedNodeId: "target", runs: [],
      draft: { revision: 1, definition }, catalog: { operations: [], models: [], savedAgents: [] },
      grant: null, validation: null, error: "", feedback: "",
    };
    const document = { activeElement: null } as ConstructorParameters<typeof FakeElement>[1];
    document.createElement = (tag) => new FakeElement(tag, document);
    document.documentElement = document.createElement("html");
    document.body = document.createElement("body");
    const root = document.createElement("section");
    document.body.append(root);
    createAutomationsWorkspace({ root, documentRoot: document, actions: { snapshot: () => snapshot } });
    expect(root.querySelector("[data-automation-node-form]")).toBeNull();
    root.querySelector('[data-action="edit-step"]')!.dispatch("click");
    const dialog = document.body.querySelector("dialog")!;
    expect(dialog.open).toBe(true);
    const source = dialog.querySelector("[data-binding-value]")!;
    const selected = source.querySelector("[selected]")!;
    expect(selected.attributes.get("value")).toBe("source");
    expect(selected.textContent).toBe("Read source · source");
    expect(source.querySelector('[value="later"]')).toBeNull();
  });
});
