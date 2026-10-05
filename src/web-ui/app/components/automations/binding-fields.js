import { escapeHtml } from "../../lib/text-format.js";
import { readSchemaLiteralValue, renderSchemaLiteralInput, schemaFieldName,
  schemaLiteralHint } from "./schema-literal-inputs.js";

function bindingText(binding) {
  if (!binding) return "";
  if (binding.kind === "literal")
    return typeof binding.value === "string" ? binding.value : JSON.stringify(binding.value ?? "");
  if (binding.kind === "run_input") return binding.input || "";
  if (binding.kind === "run_file") return binding.fileName || "";
  if (binding.kind === "source_file") return String(binding.index ?? 0);
  if (binding.kind === "node_result") return binding.nodeId || "";
  if (binding.kind === "branch_results") return binding.parallelNodeId || "";
  return "";
}

function bindingKindOptions(selected, toolInput, optional) {
  const options = [
    ["literal", toolInput ? "Enter a value" : "Literal"], ["run_input", "Run input"],
    ["run_file", "New file for this run"],
    ["source_files", "Input files"], ["source_file", "One input file"],
    ["node_result", "Earlier step"], ["branch_results", "Parallel results"],
  ];
  if (optional) options.unshift(["unset", "Not set"]);
  return options.filter(([kind]) => !toolInput || !["source_files", "branch_results"].includes(kind) || selected === kind)
    .map(([kind, label]) => `<option value="${kind}"${selected === kind ? " selected" : ""}>${label}${toolInput && ["source_files", "branch_results"].includes(kind) ? " · unavailable for tool inputs" : ""}</option>`).join("");
}

function renderEarlierStepChoice(binding, producers) {
  const selectedId = binding?.nodeId || "";
  const steps = producers.filter((producer) => producer.kind === "agent" || producer.kind === "tool");
  const isAvailable = steps.some((producer) => producer.id === selectedId);
  const options = steps.map((producer) => `<option value="${escapeHtml(producer.id)}"${producer.id === selectedId ? " selected" : ""}>${escapeHtml(producer.title || (producer.kind === "agent" ? "Agent step" : "Tool step"))} · ${escapeHtml(producer.id)}</option>`).join("");
  const missing = selectedId && !isAvailable
    ? `<option value="${escapeHtml(selectedId)}" selected>Unavailable step · ${escapeHtml(selectedId)}</option>` : "";
  return `<label>Step<select data-binding-value aria-label="Source step"><option value=""${!selectedId ? " selected" : ""}>Choose an earlier step</option>${options}${missing}</select></label>
    ${missing ? `<span class="automation-node-error">This step is no longer available before the current step.</span>` : ""}`;
}

function renderParallelGroupChoice(binding, producers) {
  const selectedId = binding?.parallelNodeId || "";
  const groups = producers.filter((producer) => producer.kind === "parallel");
  const isAvailable = groups.some((group) => group.id === selectedId);
  const options = groups.map((group) => `<option value="${escapeHtml(group.id)}"${group.id === selectedId ? " selected" : ""}>${escapeHtml(group.title)} · ${escapeHtml(group.id)}</option>`).join("");
  const missing = selectedId && !isAvailable
    ? `<option value="${escapeHtml(selectedId)}" selected>Unavailable parallel group · ${escapeHtml(selectedId)}</option>` : "";
  return `<label>Parallel group<select data-binding-value aria-label="Parallel group"><option value=""${!selectedId ? " selected" : ""}>Choose a completed parallel group</option>${options}${missing}</select></label>
    ${missing ? `<span class="automation-node-error">This parallel group is no longer available before the current step.</span>` : ""}`;
}

function renderBindingValue(kind, binding, producers, literalOptions) {
  if (kind === "unset") return `<small class="automation-muted">Not sent to the tool. Its default applies, if any.</small>`;
  if (kind === "literal" && literalOptions.property)
    return renderSchemaLiteralInput(literalOptions.property, binding?.value, literalOptions);
  if (kind === "node_result") return renderEarlierStepChoice(binding, producers);
  if (kind === "branch_results") return renderParallelGroupChoice(binding, producers);
  if (kind === "source_files") return "";
  if (kind === "run_file") return `<label>File name<input data-binding-value value="${escapeHtml(bindingText(binding))}" aria-label="File name" placeholder="result.md" maxlength="120"></label><small class="automation-muted">File name only. Each run gets its own folder inside the working directory.</small>`;
  return `<label>Value<input data-binding-value value="${escapeHtml(bindingText(binding))}" aria-label="Binding value"></label>`;
}

export function renderBindingRow(key, binding, { removable = false, required = false, optional = false, property = null, producers = [], literalType: savedLiteralType, drafts = {}, toolInput = false, multiline = false, literalDraft } = {}) {
  const defaultKind = optional ? "unset" : "literal";
  const kind = binding?.kind || defaultKind;
  const literalType = property?.type === "array" ? "json" : property?.type || savedLiteralType ||
    (typeof binding?.value === "string" || binding?.value === undefined ? "string" : "json");
  const typed = toolInput && property;
  const literalOptions = { property: typed ? property : null, key, draft: literalDraft, multiline };
  return `<div class="automation-binding-row${typed ? " automation-schema-binding" : ""}" data-binding-row data-binding-current-kind="${escapeHtml(kind)}" data-binding-schema-type="${escapeHtml(property?.type || "")}" data-binding-schema="${escapeHtml(JSON.stringify(property))}" data-binding-multiline="${multiline}" data-binding-required="${required}" data-binding-optional="${optional}" data-binding-tool-input="${toolInput}" data-binding-drafts="${escapeHtml(JSON.stringify(drafts))}">
    ${typed ? `<div class="automation-schema-heading"><strong>${escapeHtml(schemaFieldName(key))}</strong><span class="automation-required">${required ? "Required" : "Optional"}</span><input type="hidden" data-binding-key value="${escapeHtml(key)}"><small>${escapeHtml(schemaLiteralHint(property))}</small></div>` : `<label>Field<input data-binding-key value="${escapeHtml(key)}" ${removable ? "" : "readonly"} aria-label="Binding field"></label>`}
    <label>${typed ? "Value source" : "From"}<select data-binding-kind>${bindingKindOptions(kind, toolInput, optional)}</select></label>
    ${renderBindingValue(kind, binding, producers, literalOptions)}
    ${toolInput && ["source_files", "branch_results"].includes(kind) ? `<span class="automation-node-error">This saved source cannot be used by a tool input. Choose another source before saving.</span>` : ""}
    ${property || kind !== "literal" ? `<input type="hidden" data-binding-literal-type value="${escapeHtml(literalType)}">` : `<label>Literal type<select data-binding-literal-type><option value="string"${literalType === "string" ? " selected" : ""}>Text</option><option value="number"${literalType === "number" ? " selected" : ""}>Number</option><option value="boolean"${literalType === "boolean" ? " selected" : ""}>Boolean</option><option value="json"${literalType === "json" ? " selected" : ""}>JSON</option></select></label>`}
    ${kind === "node_result" ? `<label>Output<select data-binding-output><option value="text"${binding.select === "text" ? " selected" : ""}>Text</option><option value="data"${binding.select === "data" ? " selected" : ""}>Data</option></select></label>` : ""}
    ${kind === "node_result" ? `<label>JSON pointer · optional<input data-binding-pointer value="${escapeHtml(binding.pointer || "")}" placeholder="/total"></label>` : ""}
    ${kind === "source_file" ? `<label>File field<select data-binding-file-field><option value="snapshot_path">Snapshot path</option><option value="original_path"${binding.field === "original_path" ? " selected" : ""}>Original path</option><option value="version"${binding.field === "version" ? " selected" : ""}>Version</option></select></label>` : ""}
    ${required && !typed ? `<span class="automation-required">Required</span>` : ""}
    ${removable ? `<button type="button" data-remove-binding aria-label="Remove binding">Remove</button>` : ""}
  </div>`;
}

export function renderBindingFields(bindings, schema = null, { name = "inputs", allowAdd = false, producers = [] } = {}) {
  const properties = schema?.properties || {};
  const names = schema
    ? [...Object.keys(properties), ...Object.keys(bindings || {}).filter((key) => !(key in properties))]
    : Object.keys(bindings || {});
  return `<fieldset class="automation-binding-fields" data-binding-fields="${escapeHtml(name)}"><legend>${name === "controls" ? "Operation inputs" : name === "payload" ? "Raw payload" : "Step inputs"}</legend>
    ${names.map((key) => renderBindingRow(key, bindings?.[key], {
      removable: !schema || !(key in properties),
      required: schema?.required?.includes(key),
      optional: isOptionalSchemaInput(schema, key),
      property: properties[key],
      producers,
      toolInput: name !== "inputs",
      multiline: name === "payload",
    })).join("")}
    ${allowAdd ? `<div data-binding-actions>
      ${producers.length ? `<label>Receive output from<select data-connect-result-source><option value="">Choose an earlier step or parallel group</option>${producers.map((producer) => `<option value="${escapeHtml(producer.id)}">${escapeHtml(producer.title || "Step")} · ${escapeHtml(producer.id)}</option>`).join("")}</select></label><button type="button" data-add-result-binding>Connect output</button>` : ""}
      <button type="button" data-add-binding="${escapeHtml(name)}">Add input</button></div>` : ""}
  </fieldset>`;
}

function isOptionalSchemaInput(schema, key) {
  if (!schema?.properties) return false;
  if (!(key in schema.properties)) return false;
  return !schema.required?.includes(key);
}

function literalValue(row) {
  if (row.querySelector("[data-schema-literal]")) return readSchemaLiteralValue(row);
  const value = row.querySelector("[data-binding-value]").value;
  const type = row.querySelector("[data-binding-literal-type]").value;
  if (type === "boolean") {
    if (value !== "true" && value !== "false") throw new Error("Enter true or false for the selected input.");
    return value === "true";
  }
  if (type === "json") {
    try { return JSON.parse(value); }
    catch { throw new Error("Enter valid JSON for the selected input."); }
  }
  if (type === "number" || type === "integer") {
    if (!value.trim()) throw new Error("Enter a valid number for the selected input.");
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new Error("Enter a valid number for the selected input.");
    if (type === "integer" && !Number.isInteger(numeric)) throw new Error("Enter a whole number for the selected input.");
    return numeric;
  }
  return value;
}

function readBinding(row) {
  const kind = row.querySelector("[data-binding-kind]").value;
  const value = row.querySelector("[data-binding-value]")?.value.trim() || "";
  if (kind === "literal") return { kind, value: literalValue(row) };
  if (kind === "run_input") return { kind, input: value };
  if (kind === "run_file") return { kind, fileName: value };
  if (kind === "source_files") return { kind };
  if (kind === "source_file") {
    const index = Number(value);
    if (!Number.isInteger(index) || index < 0) throw new Error("Choose a valid input-file index.");
    return { kind, index, field: row.querySelector("[data-binding-file-field]")?.value || "snapshot_path" };
  }
  if (kind === "node_result") {
    const pointer = row.querySelector("[data-binding-pointer]")?.value.trim();
    return { kind, nodeId: value, select: row.querySelector("[data-binding-output]")?.value || "text", ...(pointer ? { pointer } : {}) };
  }
  return { kind: "branch_results", parallelNodeId: value };
}

export function readBindingFields(form, name) {
  const fieldset = form.querySelector(`[data-binding-fields="${name}"]`);
  if (!fieldset) return {};
  const result = {};
  for (const row of fieldset.querySelectorAll("[data-binding-row]")) {
    if (hasUnsetBinding(row)) continue;
    const key = row.querySelector("[data-binding-key]").value.trim();
    if (!key) continue;
    result[key] = readBinding(row);
  }
  return result;
}

function hasUnsetBinding(row) {
  return row.querySelector("[data-binding-kind]").value === "unset";
}
