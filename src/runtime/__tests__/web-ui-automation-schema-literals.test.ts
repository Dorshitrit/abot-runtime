import { describe, expect, test } from "vitest";
import { FakeElement } from "./support/model-setup-wizard-harness.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { readBindingFields, renderBindingFields } from "../../web-ui/app/components/automations/binding-fields.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { changeAutomationBindingKind, handleAutomationBindingClick } from "../../web-ui/app/components/automations/binding-editor.js";

function initializeControls(root: FakeElement) {
  for (const select of root.querySelectorAll("select"))
    select.value = (select.querySelector("option[selected]") || select.querySelector("option"))?.value || "";
  // FakeElement does not implement HTML's textarea initial-newline and CR normalization.
  for (const textarea of root.querySelectorAll("textarea"))
    textarea.value = textarea.textContent.replace(/^\n/u, "").replace(/\r\n?/gu, "\n");
}

function fixture(property: object, binding?: object, { required = true, name = "controls" } = {}) {
  const document = {} as ConstructorParameters<typeof FakeElement>[1];
  document.createElement = (tag) => {
    const element = new FakeElement(tag, document);
    Object.defineProperty(element, "firstElementChild", { get: () => element.children[0] });
    return element;
  };
  const form = document.createElement("form");
  form.innerHTML = renderBindingFields(binding ? { queries: binding } : {}, {
    properties: { queries: property }, required: required ? ["queries"] : [],
  }, { name });
  initializeControls(form);
  const row = () => form.querySelector("[data-binding-row]")!;
  const inputs = () => row().querySelectorAll("[data-schema-item-value]");
  const input = () => row().querySelector("[data-binding-value]")!;
  const read = () => readBindingFields(form, name);
  function changeKind(kind: string) {
    const current = row();
    Object.assign(current, { replaceWith(next: FakeElement) {
      const parent = current.parentElement!;
      parent.children = parent.children.map((child) => child === current ? next : child);
      next.parentElement = parent;
      current.parentElement = null;
    } });
    const selector = current.querySelector("[data-binding-kind]")!;
    selector.value = kind;
    changeAutomationBindingKind(selector, [], document);
    initializeControls(row());
  }
  function click(selector: string) {
    const button = row().querySelector(selector)!;
    expect(handleAutomationBindingClick(button, [], document)).toBe(true);
    initializeControls(row());
  }
  return { form, row, inputs, input, read, changeKind, click };
}

const listSchema = { type: "array", minItems: 1, maxItems: 3,
  items: { type: "string", minLength: 1, maxLength: 400 } };
const literal = (value: unknown) => ({ kind: "literal", value });

describe("schema-guided automation tool literals", () => {
  test("edits a saved string list as individual items and preserves its canonical key", () => {
    const editor = fixture(listSchema, literal(["first query", "second query"]));
    expect(editor.inputs().map((input) => input.value)).toEqual(["first query", "second query"]);
    expect(editor.row().textContent).toContain("Queries");
    expect(editor.row().textContent).toContain("1–3 items");
    expect(editor.row().textContent).toContain("1–400 characters");
    expect(editor.row().querySelector("[data-binding-key]")?.type).toBe("hidden");
    expect(editor.inputs()[0]!.attributes.get("dir")).toBe("auto");
    editor.inputs()[1]!.value = "edited query";
    expect(editor.read()).toEqual({ queries: literal(["first query", "edited query"]) });
    expect(fixture(listSchema, editor.read().queries).read()).toEqual(editor.read());
  });

  test("adds/removes individual items within bounds without dropping other edits", () => {
    const editor = fixture(listSchema, literal(["first", "second"]));
    editor.inputs()[0]!.value = "edited";
    editor.click("[data-schema-add]");
    expect(editor.inputs().map((input) => input.value)).toEqual(["edited", "second", ""]);
    editor.inputs()[2]!.value = "third";
    expect(editor.row().querySelector("[data-schema-add]")?.disabled).toBe(true);
    editor.click("[data-schema-add]");
    expect(editor.inputs()).toHaveLength(3);
    editor.click('[data-schema-remove="1"]');
    expect(editor.read()).toEqual({ queries: literal(["edited", "third"]) });
    editor.click('[data-schema-remove="1"]');
    expect(editor.row().querySelector("[data-schema-remove]")?.disabled).toBe(true);
    editor.click('[data-schema-remove="0"]');
    expect(editor.read()).toEqual({ queries: literal(["edited"]) });
  });

  test("retains the entire draft, blank items, duplicates and schema through source switches", () => {
    const schema = { ...listSchema, items: { type: "string", minLength: 0, maxLength: 400 } };
    const editor = fixture(schema, literal(["duplicate", "duplicate"]), { required: false });
    editor.click("[data-schema-add]");
    editor.changeKind("node_result");
    editor.input().value = "producer";
    editor.row().querySelector("[data-binding-output]")!.value = "data";
    editor.row().querySelector("[data-binding-pointer]")!.value = "/items";
    expect(editor.read()).toEqual({ queries: { kind: "node_result", nodeId: "producer", select: "data", pointer: "/items" } });
    editor.changeKind("literal");
    expect(editor.read()).toEqual({ queries: literal(["duplicate", "duplicate", ""]) });
    expect(JSON.parse(editor.row().dataset.bindingSchema)).toEqual(schema);
    expect(editor.inputs()[0]!.attributes.get("maxlength")).toBe("400");
    expect(editor.row().querySelector("[data-schema-add]")?.disabled).toBe(true);
    editor.changeKind("unset");
    expect(editor.read()).toEqual({});
    editor.changeKind("literal");
    expect(editor.read()).toEqual({ queries: literal(["duplicate", "duplicate", ""]) });
    editor.changeKind("node_result");
    expect(editor.read().queries).toEqual({ kind: "node_result", nodeId: "producer", select: "data", pointer: "/items" });
  });

  test("keeps optional unset distinct from an explicit empty list", () => {
    const schema = { ...listSchema, minItems: 0 };
    const editor = fixture(schema, undefined, { required: false });
    expect(editor.read()).toEqual({});
    editor.changeKind("literal");
    expect(editor.read()).toEqual({ queries: literal([]) });
    editor.changeKind("unset");
    expect(editor.read()).toEqual({});
    editor.changeKind("literal");
    expect(editor.read()).toEqual({ queries: literal([]) });
  });

  test.each([
    [{ type: "integer", minimum: 0, maximum: 5 }, "1.5", "whole number"],
    [{ type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, "9007199254740992", "whole number"],
    [{ type: "number", minimum: 0, maximum: 5 }, "6", "maximum is 5"],
    [{ type: "number", minimum: 0, maximum: 5 }, "-1", "minimum is 0"],
    [{ type: "number", minimum: 0, maximum: 5 }, "", "valid number"],
    [{ type: "string", minLength: 2, maxLength: 4 }, "a", "at least 2"],
    [{ type: "string", minLength: 2, maxLength: 4 }, "abcde", "at most 4"],
  ])("validates scalar schema %j at Save", (schema, text, error) => {
    const editor = fixture(schema);
    editor.input().value = text;
    expect(() => editor.read()).toThrow(error);
  });

  test("uses inclusive numeric bounds and exact boolean values", () => {
    const numeric = fixture({ type: "number", minimum: 0, maximum: 5 }, literal(0));
    expect(numeric.input().type).toBe("number");
    expect(numeric.input().attributes.get("min")).toBe("0");
    expect(numeric.input().attributes.get("max")).toBe("5");
    expect(numeric.read()).toEqual({ queries: literal(0) });
    numeric.input().value = "5";
    expect(numeric.read()).toEqual({ queries: literal(5) });
    const boolean = fixture({ type: "boolean" }, literal(false));
    expect(boolean.input().tagName).toBe("SELECT");
    expect(boolean.read()).toEqual({ queries: literal(false) });
    boolean.input().value = "true";
    expect(boolean.read()).toEqual({ queries: literal(true) });
  });

  test("distinguishes an explicit empty enum from no choice and retains removed choices", () => {
    const schema = { type: "string", enum: ["", "full"] };
    const fresh = fixture(schema, undefined, { required: false });
    fresh.changeKind("literal");
    expect(() => fresh.read()).toThrow("choose one");
    fresh.input().value = "0";
    expect(fresh.read()).toEqual({ queries: literal("") });
    fresh.changeKind("run_input");
    fresh.changeKind("literal");
    expect(fresh.read()).toEqual({ queries: literal("") });
    expect(fixture(schema, literal("")).read()).toEqual({ queries: literal("") });
    const stale = fixture(schema, literal("removed"));
    expect(stale.input().textContent).toContain("Unavailable value · removed");
    expect(() => stale.read()).toThrow("choose one");
    stale.changeKind("run_input");
    stale.changeKind("literal");
    expect(stale.input().textContent).toContain("Unavailable value · removed");
  });

  test("preserves scalar and list strings with leading newlines and CRLF on roundtrip", () => {
    const text = "\nline one\r\nline two\r";
    const schema = { type: "string", minLength: 0, maxLength: 400 };
    const scalar = fixture(schema, literal(text));
    expect(scalar.input().tagName).toBe("TEXTAREA");
    expect(scalar.input().attributes.get("dir")).toBe("auto");
    expect(scalar.read()).toEqual({ queries: literal(text) });
    scalar.changeKind("run_input");
    scalar.changeKind("literal");
    expect(scalar.read()).toEqual({ queries: literal(text) });
    const list = fixture({ ...listSchema, items: schema }, literal([text]));
    expect(list.read()).toEqual({ queries: literal([text]) });
    list.click("[data-schema-add]");
    list.inputs()[1]!.value = "another";
    expect(list.read()).toEqual({ queries: literal([text, "another"]) });
  });

  test("uses multiline text for raw payloads without trimming", () => {
    const value = "\n report content \n";
    const editor = fixture({ type: "string" }, literal(value), { name: "payload" });
    expect(editor.input().tagName).toBe("TEXTAREA");
    expect(editor.read()).toEqual({ queries: literal(value) });
  });

  test.each([
    [{ type: "boolean" }, "false"], [{ type: "string" }, true],
    [{ type: "integer", minimum: 0, maximum: 5 }, "2"],
    [listSchema, "[\"one\"]"], [listSchema, null],
  ])("preserves a wrong-type saved value for schema %j without coercion", (schema, value) => {
    const editor = fixture(schema, literal(value));
    expect(editor.input().value).toBe(JSON.stringify(value));
    expect(editor.input().dataset.schemaInvalid).toBe("true");
    expect(() => editor.read()).toThrow();
    editor.changeKind("run_input");
    editor.changeKind("literal");
    expect(editor.input().value).toBe(JSON.stringify(value));
    expect(() => editor.read()).toThrow();
  });

  test("preserves all invalid list items until explicitly repaired", () => {
    const editor = fixture(listSchema, literal(["one", true, "three", "four"]));
    expect(editor.inputs()).toHaveLength(4);
    expect(editor.inputs()[1]!.value).toBe("true");
    expect(editor.inputs()[1]!.dataset.schemaInvalid).toBe("true");
    expect(editor.row().querySelector("[data-schema-add]")?.disabled).toBe(true);
    expect(() => editor.read()).toThrow("at most 3");
    editor.click('[data-schema-remove="3"]');
    expect(() => editor.read()).toThrow("expected string");
    editor.inputs()[1]!.value = '"fixed"';
    expect(editor.read()).toEqual({ queries: literal(["one", "fixed", "three"]) });
    const empty = fixture(listSchema, literal([]));
    expect(empty.inputs()).toHaveLength(0);
    expect(() => empty.read()).toThrow("at least 1");
  });

  test("array item bounds survive editing and source switches", () => {
    const schema = { ...listSchema, items: { type: "integer", minimum: 0, maximum: 5 } };
    const editor = fixture(schema, literal([0, 5]));
    expect(editor.read()).toEqual({ queries: literal([0, 5]) });
    editor.inputs()[0]!.value = "6";
    editor.changeKind("run_input");
    editor.changeKind("literal");
    expect(editor.inputs()[0]!.value).toBe("6");
    expect(editor.inputs()[0]!.attributes.get("max")).toBe("5");
    expect(() => editor.read()).toThrow("maximum is 5");
  });

  test.each([
    [{ type: "boolean" }, [false, true]],
    [{ type: "string", enum: ["", "second"] }, ["", "second"]],
  ])("preserves typed array item choices for %j", (items, value) => {
    const editor = fixture({ ...listSchema, items }, literal(value));
    expect(editor.inputs().every((input) => input.tagName === "SELECT")).toBe(true);
    expect(editor.read()).toEqual({ queries: literal(value) });
    editor.changeKind("run_input");
    editor.changeKind("literal");
    expect(editor.read()).toEqual({ queries: literal(value) });
  });
});
