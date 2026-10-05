import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { FakeElement } from "./support/model-setup-wizard-harness.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { readBindingFields, renderBindingFields } from "../../web-ui/app/components/automations/binding-fields.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { changeAutomationBindingKind } from "../../web-ui/app/components/automations/binding-editor.js";

const documentReader = JSON.parse(readFileSync(new URL(
  "../../../plugins/document-reader/plugin.json", import.meta.url), "utf8"))
  .extensions["ai.abot.runtime"].capabilities.document_reader.operations.read_document;

function setSelectDefaults(root: FakeElement) {
  for (const select of root.querySelectorAll("select")) {
    const option = select.querySelector("option[selected]") || select.querySelector("option");
    select.value = option?.value || "";
  }
}

function fixture(bindings: object, schema: object | null) {
  const document = {} as ConstructorParameters<typeof FakeElement>[1];
  document.createElement = (tag) => {
    const element = new FakeElement(tag, document);
    Object.defineProperty(element, "firstElementChild", { get: () =>
      element.children.find((child) => child instanceof FakeElement) });
    return element;
  };
  const form = document.createElement("form");
  form.innerHTML = renderBindingFields(bindings, schema, { name: "controls" });
  setSelectDefaults(form);
  const row = (name: string) => form.querySelectorAll("[data-binding-row]")
    .find((candidate) => candidate.querySelector("[data-binding-key]")?.value === name)!;
  const changeKind = (name: string, kind: string) => {
    const current = row(name);
    Object.assign(current, { replaceWith(next: FakeElement) {
      const parent = current.parentElement!;
      parent.children = parent.children.map((child) => child === current ? next : child);
      next.parentElement = parent;
      current.parentElement = null;
    } });
    const selector = current.querySelector("[data-binding-kind]")!;
    selector.value = kind;
    changeAutomationBindingKind(selector, [], document);
    setSelectDefaults(row(name));
  };
  return { form, row, changeKind, read: () => readBindingFields(form, "controls") };
}

describe("ABot Studio optional operation inputs", () => {
  test("saving a document reader source leaves unconfigured options absent", () => {
    const controls = { source: { kind: "literal", value: "guide.md" } };
    const editor = fixture(controls, documentReader.input);
    expect(editor.row("source").querySelector("[data-binding-kind]")?.value).toBe("literal");
    for (const name of ["source_mode", "path", "start_char", "max_chars"]) {
      expect(editor.row(name).querySelector("[data-binding-kind]")?.value).toBe("unset");
      expect(editor.row(name).querySelector("[data-binding-value]")).toBeNull();
    }
    expect(editor.read()).toEqual(controls);
    expect(fixture(editor.read(), documentReader.input).read()).toEqual(controls);
  });

  test("untouched optional text, number, boolean and JSON fields are not serialized", () => {
    const editor = fixture({}, { properties: {
      text: { type: "string" }, count: { type: "number" }, enabled: { type: "boolean" },
      items: { type: "array" },
    } });
    expect(editor.read()).toEqual({});
  });

  test.each([
    ["boolean", false, "false"], ["integer", 0, "0"], ["string", "", ""],
  ])("preserves explicit %s literals through save, unset and source changes", (type, value, text) => {
    const schema = { properties: { option: { type } } };
    const binding = { option: { kind: "literal", value } };
    const editor = fixture(binding, schema);
    expect(editor.read()).toEqual(binding);
    editor.changeKind("option", "unset");
    expect(editor.read()).toEqual({});
    expect(fixture(editor.read(), schema).read()).toEqual({});
    editor.changeKind("option", "literal");
    expect(editor.row("option").querySelector("[data-binding-value]")?.value).toBe(text);
    expect(editor.read()).toEqual(binding);
    editor.changeKind("option", "run_input");
    editor.row("option").querySelector("[data-binding-value]")!.value = "chosen";
    expect(editor.read()).toEqual({ option: { kind: "run_input", input: "chosen" } });
    editor.changeKind("option", "literal");
    expect(editor.read()).toEqual(binding);
  });

  test.each([
    ["boolean", "false", false], ["number", "0", 0], ["string", "", ""],
  ])("setting a new optional %s field keeps its explicit value", (type, text, value) => {
    const editor = fixture({}, { properties: { option: { type } } });
    editor.changeKind("option", "literal");
    editor.row("option").querySelector("[data-binding-value]")!.value = String(text);
    expect(editor.read()).toEqual({ option: { kind: "literal", value } });
  });

  test("an earlier-step optional binding can be removed and restored before saving", () => {
    const binding = { option: { kind: "node_result", nodeId: "read", select: "data", pointer: "/count" } };
    const editor = fixture(binding, { properties: { option: { type: "integer" } } });
    editor.changeKind("option", "unset");
    expect(editor.read()).toEqual({});
    editor.changeKind("option", "node_result");
    expect(editor.read()).toEqual(binding);
  });

  test.each(["number", "integer"])("blank %s literals are not silently converted to zero", (type) => {
    const editor = fixture({}, { properties: { option: { type } } });
    editor.changeKind("option", "literal");
    expect(() => editor.read()).toThrow("Enter a valid number");
    editor.row("option").querySelector("[data-binding-value]")!.value = "   ";
    expect(() => editor.read()).toThrow("Enter a valid number");
    editor.changeKind("option", "unset");
    expect(editor.read()).toEqual({});
  });

  test("required and freeform bindings have no unset source", () => {
    const required = fixture({}, { properties: { path: { type: "string" } }, required: ["path"] });
    expect(required.row("path").querySelector('option[value="unset"]')).toBeNull();
    required.row("path").querySelector("[data-binding-value]")!.value = "guide.md";
    expect(required.read()).toEqual({ path: { kind: "literal", value: "guide.md" } });
    const freeform = fixture({ source: { kind: "literal", value: "" } }, null);
    expect(freeform.row("source").querySelector('option[value="unset"]')).toBeNull();
    expect(freeform.read()).toEqual({ source: { kind: "literal", value: "" } });
  });
});
