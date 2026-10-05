import { renderBindingRow } from "./binding-fields.js";
import { captureSchemaLiteralDraft, handleSchemaLiteralClick, readBindingSchema } from "./schema-literal-inputs.js";

export function refreshAutomationInputNotice(form) {
  const notice = form?.querySelector("[data-input-connection]");
  if (!notice) return;
  const connected = [...form.querySelectorAll('[data-binding-fields="inputs"] [data-binding-row]')]
    .some((row) => {
      const kind = row.querySelector("[data-binding-kind]")?.value;
      if (kind !== "node_result" && kind !== "branch_results") return false;
      return Boolean(row.querySelector("[data-binding-value]")?.value.trim() &&
        row.querySelector("[data-binding-key]")?.value.trim());
    });
  notice.hidden = connected;
  notice.dataset.inputConnection = connected ? "connected" : "none";
}

function appendInputRow(fields, key, binding, producers, documentRoot) {
  const wrapper = documentRoot.createElement("div");
  wrapper.innerHTML = renderBindingRow(key, binding, { removable: true, producers });
  const row = wrapper.firstElementChild;
  fields.insertBefore(row, fields.querySelector("[data-binding-actions]"));
  row.querySelector("[data-binding-key]")?.focus();
  refreshAutomationInputNotice(fields.closest("form"));
}

function nextInputName(fields) {
  const names = new Set([...fields.querySelectorAll("[data-binding-key]")]
    .map((input) => input.value.trim()));
  if (!names.has("source")) return "source";
  let index = 2;
  while (names.has(`source_${index}`)) index += 1;
  return `source_${index}`;
}

export function handleAutomationBindingClick(element, producers, documentRoot) {
  if (handleSchemaLiteralClick(element)) return true;
  if (element.dataset.removeBinding !== undefined) {
    const form = element.closest("form");
    element.closest("[data-binding-row]")?.remove();
    refreshAutomationInputNotice(form);
    return true;
  }
  const fields = element.closest("[data-binding-fields]");
  if (!fields) return false;
  if (element.dataset.addResultBinding !== undefined) {
    const source = fields.querySelector("[data-connect-result-source]");
    const producer = producers.find((candidate) => candidate.id === source?.value);
    if (!producer) {
      source?.focus();
      return false;
    }
    const binding = producer.kind === "parallel"
      ? { kind: "branch_results", parallelNodeId: producer.id }
      : { kind: "node_result", nodeId: producer.id, select: "text" };
    appendInputRow(fields, nextInputName(fields), binding, producers, documentRoot);
    return true;
  }
  if (element.dataset.addBinding === undefined) return false;
  appendInputRow(fields, "", { kind: "literal", value: "" }, producers, documentRoot);
  return true;
}

export function changeAutomationBindingKind(selector, producers, documentRoot) {
  const row = selector.closest("[data-binding-row]");
  const previousKind = row.dataset.bindingCurrentKind;
  const drafts = JSON.parse(row.dataset.bindingDrafts || "{}");
  drafts[previousKind] = {
    value: row.querySelector("[data-binding-value]")?.value || "",
    literalType: row.querySelector("[data-binding-literal-type]").value,
    select: row.querySelector("[data-binding-output]")?.value,
    pointer: row.querySelector("[data-binding-pointer]")?.value,
    fileField: row.querySelector("[data-binding-file-field]")?.value,
    schemaLiteral: captureSchemaLiteralDraft(row),
  };
  const selected = drafts[selector.value] || {};
  const value = selected.value;
  const replacement = documentRoot.createElement("div");
  replacement.innerHTML = renderBindingRow(row.querySelector("[data-binding-key]").value, {
    kind: selector.value, value, nodeId: value, input: value,
    fileName: value,
    index: Number(value) || 0, parallelNodeId: value,
    select: selected.select,
    pointer: selected.pointer,
    field: selected.fileField,
  }, {
    removable: Boolean(row.querySelector("[data-remove-binding]")),
    required: row.dataset.bindingRequired === "true",
    optional: row.dataset.bindingOptional === "true",
    toolInput: row.dataset.bindingToolInput === "true",
    property: readBindingSchema(row),
    multiline: row.dataset.bindingMultiline === "true",
    literalDraft: selected.schemaLiteral,
    literalType: selected.literalType || row.querySelector("[data-binding-literal-type]").value,
    drafts,
    producers,
  });
  const nextRow = replacement.firstElementChild;
  row.replaceWith(nextRow);
  refreshAutomationInputNotice(nextRow.closest("form"));
}
