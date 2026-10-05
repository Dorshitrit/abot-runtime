import { escapeHtml } from "../../lib/text-format.js";

export function schemaFieldName(key) {
  const words = String(key).replace(/([a-z\d])([A-Z])/gu, "$1 $2").replace(/[_-]+/gu, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function rangeHint(minimum, maximum, unit) {
  if (minimum !== undefined && maximum !== undefined) return `${minimum}–${maximum} ${unit}`;
  if (minimum !== undefined) return `At least ${minimum} ${unit}`;
  if (maximum !== undefined) return `Up to ${maximum} ${unit}`;
  return "";
}

export function schemaLiteralHint(property) {
  if (property.type === "array") {
    const count = rangeHint(property.minItems, property.maxItems, "items");
    const item = property.items ? `Each item: ${schemaLiteralHint(property.items)}` : "";
    return ["List", count, item].filter(Boolean).join(" · ");
  }
  if (property.enum) return `Choose one of ${property.enum.length} options`;
  if (property.type === "boolean") return "True or false";
  if (property.type === "number" || property.type === "integer")
    return [property.type === "integer" ? "Whole number" : "Number",
      rangeHint(property.minimum, property.maximum, "")].filter(Boolean).join(" · ").trim();
  return ["Text", rangeHint(property.minLength, property.maxLength, "characters")]
    .filter(Boolean).join(" · ");
}

function hasScalarType(value, property) {
  if (property.type === "integer" || property.type === "number")
    return typeof value === "number" && Number.isFinite(value);
  return typeof value === property.type;
}

function scalarDraft(value, property) {
  if (value === undefined) return { value: "", unset: true };
  if (!hasScalarType(value, property)) return { value: JSON.stringify(value), invalid: true };
  return { value: String(value) };
}

function initialLiteralDraft(property, value) {
  if (property.type !== "array") return scalarDraft(value, property);
  if (value !== undefined && !Array.isArray(value))
    return { value: JSON.stringify(value), invalid: true };
  if (!property.items) return { value: JSON.stringify(value ?? []), invalid: true };
  const items = value ?? Array.from({ length: property.minItems ?? 0 }, () => undefined);
  return { items: items.map((item) => scalarDraft(item, property.items)) };
}

function constraintAttribute(name, value) {
  return value === undefined ? "" : ` ${name}="${escapeHtml(value)}"`;
}

export function readBindingSchema(row) {
  if (row.dataset.bindingSchema) return JSON.parse(row.dataset.bindingSchema);
  if (row.dataset.bindingSchemaType) return { type: row.dataset.bindingSchemaType };
  return null;
}

function renderEnum(property, draft, common) {
  const choices = property.enum;
  const index = draft.unset ? -1 : choices.indexOf(draft.value);
  const unavailable = !draft.unset && index < 0;
  return `<select ${common} data-schema-enum="${escapeHtml(JSON.stringify(choices))}" data-schema-enum-saved="${escapeHtml(draft.value ?? "")}"><option value=""${draft.unset ? " selected" : ""}>Choose a value</option>${unavailable ? `<option value="saved" selected>Unavailable value · ${escapeHtml(draft.value)}</option>` : ""}${choices.map((choice, position) => `<option value="${position}"${position === index ? " selected" : ""}>${escapeHtml(choice || "Empty text")}</option>`).join("")}</select>`;
}

function renderTextarea(common, value, attributes = "") {
  const rendered = value.replace(/\r\n?/gu, "\n");
  return `<textarea ${common}${attributes} dir="auto" data-schema-original="${escapeHtml(JSON.stringify(value))}" data-schema-rendered="${escapeHtml(JSON.stringify(rendered))}" rows="5">\n${escapeHtml(value)}</textarea>`;
}

function renderScalar(property, draft, label, { item = false, multiline = false } = {}) {
  const marker = item ? "data-schema-item-value" : "data-binding-value";
  const value = draft.value ?? "";
  const common = `${marker} aria-label="${escapeHtml(label)}"`;
  if (draft.invalid)
    return `<label class="automation-schema-invalid">Saved value (JSON)${renderTextarea(common, value, ' data-schema-invalid="true" spellcheck="false"')}<small>The saved value has the wrong type. Correct its JSON value before saving.</small></label>`;
  if (property.enum) return renderEnum(property, draft, common);
  if (property.type === "boolean")
    return `<select ${common}><option value=""${value === "" ? " selected" : ""}>Choose a value</option>${["true", "false"].map((choice) => `<option value="${choice}"${choice === value ? " selected" : ""}>${choice}</option>`).join("")}</select>`;
  if (property.type === "number" || property.type === "integer")
    return `<input type="number" ${common} value="${escapeHtml(value)}" step="${property.type === "integer" ? "1" : "any"}"${constraintAttribute("min", property.minimum)}${constraintAttribute("max", property.maximum)}>`;
  const lengths = constraintAttribute("minlength", property.minLength) + constraintAttribute("maxlength", property.maxLength);
  if (multiline || /[\r\n]/u.test(value)) return renderTextarea(common, value, lengths);
  return `<input type="text" ${common} dir="auto" value="${escapeHtml(value)}"${lengths}>`;
}

function listCountIssue(property, count) {
  if (property.minItems !== undefined && count < property.minItems)
    return `add at least ${property.minItems} items.`;
  if (property.maxItems !== undefined && count > property.maxItems)
    return `use at most ${property.maxItems} items.`;
  return "";
}

function renderArray(property, items, label) {
  const minimum = property.minItems ?? 0;
  const atMaximum = property.maxItems !== undefined && items.length >= property.maxItems;
  return `<div class="automation-schema-items">${items.map((draft, index) => `<div class="automation-schema-item" data-schema-item><span class="automation-schema-item-number">${index + 1}</span>${renderScalar(property.items, draft, `${label} · item ${index + 1}`, { item: true })}<button type="button" data-schema-remove="${index}" aria-label="Remove item ${index + 1}"${items.length <= minimum ? " disabled" : ""}>Remove</button></div>`).join("")}</div>
    <div class="automation-schema-list-actions"><button type="button" data-schema-add${atMaximum ? " disabled" : ""}>Add item</button><small>${items.length} item${items.length === 1 ? "" : "s"}</small></div>${listCountIssue(property, items.length) ? `<small class="automation-node-error">${escapeHtml(label)}: ${escapeHtml(listCountIssue(property, items.length))}</small>` : ""}`;
}

export function renderSchemaLiteralInput(property, value, { key, draft, multiline = false }) {
  const current = draft ?? initialLiteralDraft(property, value);
  const label = schemaFieldName(key);
  if (property.type === "array" && !current.invalid)
    return `<div class="automation-schema-literal" data-schema-literal data-schema-list>${renderArray(property, current.items, label)}</div>`;
  return `<div class="automation-schema-literal" data-schema-literal>${renderScalar(property, current, label, { multiline })}</div>`;
}

function captureScalarDraft(input) {
  if (input.dataset.schemaEnum) {
    const choices = JSON.parse(input.dataset.schemaEnum);
    if (input.value === "") return { value: "", unset: true };
    if (input.value === "saved") return { value: input.dataset.schemaEnumSaved };
    return { value: choices[Number(input.value)] };
  }
  let value = input.value;
  if (input.dataset.schemaRendered && value === JSON.parse(input.dataset.schemaRendered))
    value = JSON.parse(input.dataset.schemaOriginal);
  return { value, ...(input.dataset.schemaInvalid === "true" ? { invalid: true } : {}) };
}

export function captureSchemaLiteralDraft(row) {
  const container = row.querySelector("[data-schema-literal]");
  if (!container) return undefined;
  if (container.hasAttribute("data-schema-list"))
    return { items: [...container.querySelectorAll("[data-schema-item-value]")].map(captureScalarDraft) };
  return captureScalarDraft(container.querySelector("[data-binding-value]"));
}

function parseJsonDraft(draft, label) {
  try { return JSON.parse(draft.value); }
  catch { throw new Error(`${label}: enter valid JSON to correct the saved value.`); }
}

function parseScalarDraft(draft, property, label) {
  if (draft.invalid) return parseJsonDraft(draft, label);
  if (property.enum && draft.unset) throw new Error(`${label}: choose one of the available options.`);
  if (property.type === "boolean") {
    if (draft.value === "true") return true;
    if (draft.value === "false") return false;
    throw new Error(`${label}: choose true or false.`);
  }
  if (property.type === "integer" || property.type === "number") {
    if (!draft.value.trim()) throw new Error(`${label}: Enter a valid number.`);
    const value = Number(draft.value);
    if (!Number.isFinite(value)) throw new Error(`${label}: Enter a valid number.`);
    return value;
  }
  return draft.value;
}

function validateSchemaLiteralValue(value, property, label) {
  if (property.type === "array") {
    if (!Array.isArray(value)) throw new Error(`${label}: enter a list of items.`);
    const countIssue = listCountIssue(property, value.length);
    if (countIssue) throw new Error(`${label}: ${countIssue}`);
    if (!property.items) throw new Error(`${label}: the item schema is unavailable.`);
    value.forEach((item, index) => validateSchemaLiteralValue(item, property.items, `${label} · item ${index + 1}`));
    return;
  }
  if (!hasScalarType(value, property)) throw new Error(`${label}: expected ${property.type}.`);
  if (property.enum && !property.enum.includes(value)) throw new Error(`${label}: choose one of the available options.`);
  if (property.type === "integer" && !Number.isSafeInteger(value)) throw new Error(`${label}: enter a supported whole number.`);
  if (property.minimum !== undefined && value < property.minimum) throw new Error(`${label}: minimum is ${property.minimum}.`);
  if (property.maximum !== undefined && value > property.maximum) throw new Error(`${label}: maximum is ${property.maximum}.`);
  if (property.minLength !== undefined && value.length < property.minLength)
    throw new Error(`${label}: enter at least ${property.minLength} characters.`);
  if (property.maxLength !== undefined && value.length > property.maxLength)
    throw new Error(`${label}: use at most ${property.maxLength} characters.`);
}

function parseLiteralDraft(draft, property, label) {
  if (draft.invalid) return parseJsonDraft(draft, label);
  if (property.type === "array") return draft.items.map((item, index) =>
    parseScalarDraft(item, property.items, `${label} · item ${index + 1}`));
  return parseScalarDraft(draft, property, label);
}

export function readSchemaLiteralValue(row) {
  const property = readBindingSchema(row);
  const label = schemaFieldName(row.querySelector("[data-binding-key]").value);
  const value = parseLiteralDraft(captureSchemaLiteralDraft(row), property, label);
  validateSchemaLiteralValue(value, property, label);
  return value;
}

export function handleSchemaLiteralClick(element) {
  const adding = element.dataset.schemaAdd !== undefined;
  const removing = element.dataset.schemaRemove !== undefined;
  if (!adding && !removing) return false;
  const row = element.closest("[data-binding-row]");
  const list = row?.querySelector("[data-schema-list]");
  if (!list) return false;
  const property = readBindingSchema(row);
  const draft = captureSchemaLiteralDraft(row);
  const items = draft.items;
  if (adding && property.maxItems !== undefined && items.length >= property.maxItems) return true;
  if (removing && items.length <= (property.minItems ?? 0)) return true;
  if (adding) items.push({ value: "", unset: true });
  if (removing) {
    const index = Number(element.dataset.schemaRemove);
    if (!Number.isInteger(index) || index < 0 || index >= items.length) return true;
    items.splice(index, 1);
  }
  const label = schemaFieldName(row.querySelector("[data-binding-key]").value);
  list.innerHTML = renderArray(property, items, label);
  if (adding) list.querySelectorAll("[data-schema-item-value]")[items.length - 1]?.focus();
  return true;
}
