import { renderReasoningModeField, retainedReasoningMode } from "../../lib/reasoning-controls.js";
import { escapeHtml } from "../../lib/text-format.js";
import { readBindingFields, renderBindingFields } from "./binding-fields.js";
import { hasConnectedAutomationResultInput } from "../../lib/automation-binding-producers.js";
import { renderAutomationNodeDetails } from "./timeline.js";
import { requiresFullPlus } from "./permission-selection.js";
import { toolDisplayName } from "./tool-identity.js";

function sameOperation(left, right) {
  return left?.toolName === right?.toolName &&
    left?.operationId === right?.operationId &&
    left?.contractVersion === right?.contractVersion;
}

export function operationIdentity(item) {
  return JSON.stringify([item.toolName, item.operationId, item.contractVersion]);
}

function operationChoices(catalog) {
  return Array.isArray(catalog?.grantableOperations)
    ? catalog.grantableOperations : catalog?.operations || [];
}

function selectedOperation(node, catalog) {
  return operationChoices(catalog).find((item) => sameOperation(item, node.operation)) || null;
}

function renderModelChoice(node, catalog) {
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const currentFound = models.some((item) => item.id === node.modelProfileId);
  return `<label>Model<select name="modelProfileId" required><option value="">Select a model</option>
    ${!currentFound && node.modelProfileId ? `<option value="${escapeHtml(node.modelProfileId)}" selected disabled>${escapeHtml(node.modelProfileId)} · unavailable</option>` : ""}
    ${models.map((item) => `<option value="${escapeHtml(item.id)}"${item.id === node.modelProfileId ? " selected" : ""}>${escapeHtml(item.label || item.id)}${item.local === true ? " · Local" : item.local === false ? " · Cloud" : ""}</option>`).join("")}</select></label>`;
}

function catalogDisplayName(value) {
  if (String(value || "").includes(" ")) return String(value).trim();
  return String(value || "").split(/[_\s-]+/u).filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");
}

function groupAgentTools(operations) {
  const plugins = new Map();
  for (const operation of operations) {
    const pluginName = operation.pluginName || "Built-in";
    if (!plugins.has(pluginName)) plugins.set(pluginName, new Map());
    const tools = plugins.get(pluginName);
    if (!tools.has(operation.toolName)) tools.set(operation.toolName, []);
    tools.get(operation.toolName).push(operation);
  }
  return plugins;
}

function renderAgentToolOperation(item, configured, granted) {
  const selected = configured.find((tool) => sameOperation(item, tool.operation));
  const key = operationIdentity(item);
  const name = catalogDisplayName(item.operationId);
  const permission = granted.has(key) ? "Allowed for this automation"
    : `${requiresFullPlus(item) ? "FULL+" : "Full"} permission needed when publishing`;
  const search = `${name} ${item.operationId} ${item.label || ""}`.toLocaleLowerCase();
  return `<div class="automation-agent-operation" data-agent-operation data-agent-search-name="${escapeHtml(search)}">
    <label class="automation-agent-operation-choice"><input type="checkbox" data-agent-tool="${escapeHtml(key)}"${selected ? " checked" : ""}><strong>${escapeHtml(name)}</strong></label>
    <div class="automation-agent-operation-options" data-agent-tool-options${selected ? "" : " hidden"}>
      <label>Usage<select aria-label="Usage for ${escapeHtml(name)}" data-tool-usage="${escapeHtml(key)}"><option value="available"${selected?.usage !== "required" ? " selected" : ""}>Available</option><option value="required"${selected?.usage === "required" ? " selected" : ""}>Required</option></select></label>
      <small class="automation-agent-operation-permission" data-granted="${granted.has(key)}">${permission}</small>
    </div>
    ${item.label ? `<details class="automation-agent-operation-help"><summary>What this operation does</summary><p>${escapeHtml(item.label)}</p></details>` : ""}
  </div>`;
}

function renderAgentTools(node, catalog) {
  const operations = Array.isArray(catalog?.grantableOperations)
    ? catalog.grantableOperations : catalog?.operations || [];
  const granted = new Set((catalog?.operations || []).map(operationIdentity));
  const configured = Array.isArray(node.tools) ? node.tools : [];
  const unavailable = configured.filter((tool) => !operations.some((item) => sameOperation(item, tool.operation)));
  const selectedCount = configured.length - unavailable.length;
  const groups = [...groupAgentTools(operations).entries()];
  return `<fieldset class="automation-agent-tools" data-agent-tools data-unavailable-count="${unavailable.length}"${unavailable.length ? " data-unavailable=true" : ""}><legend>Agent tools</legend>
    <p class="automation-muted">Choose the operations this agent may use. Access is confirmed when publishing.</p>
    ${operations.length ? `<details class="automation-agent-tool-picker"><summary><span>Choose tool operations</span><strong data-agent-tool-count>${selectedCount} selected${unavailable.length ? ` · ${unavailable.length} unavailable` : ""}</strong></summary>
      <div class="automation-agent-tool-picker-body"><label class="automation-agent-tool-search">Search tools or operations<input type="search" data-agent-tool-search placeholder="Search by name" autocomplete="off"></label>
        <p class="automation-agent-tool-usage-help">Available: the agent may choose it. Required: it must complete successfully, or the step fails.</p>
        <div class="automation-agent-tool-groups">${groups.map(([pluginName, tools]) => `<section class="automation-agent-plugin" data-agent-plugin data-agent-search-name="${escapeHtml(`${catalogDisplayName(pluginName)} ${pluginName}`.toLocaleLowerCase())}"><h5>${escapeHtml(catalogDisplayName(pluginName))}</h5>
          ${[...tools.entries()].map(([toolName, items]) => {
            const chosen = items.filter((item) => configured.some((tool) => sameOperation(item, tool.operation))).length;
            const description = items.find((item) => item.toolDescription)?.toolDescription || "";
            const search = `${catalogDisplayName(toolName)} ${toolName} ${description}`.toLocaleLowerCase();
            return `<details class="automation-agent-tool-group" data-agent-tool-group data-agent-search-name="${escapeHtml(search)}"${chosen ? " open" : ""}><summary><strong>${escapeHtml(catalogDisplayName(toolName))}</strong><small data-agent-tool-group-count>${chosen} selected · ${items.length} operation${items.length === 1 ? "" : "s"}</small></summary>
              ${description ? `<p class="automation-agent-tool-description">${escapeHtml(description)}</p>` : ""}
              <div class="automation-agent-operations">${items.map((item) => renderAgentToolOperation(item, configured, granted)).join("")}</div></details>`;
          }).join("")}</section>`).join("")}</div>
        <p class="automation-muted" data-agent-tool-no-results hidden>No matching tools or operations.</p>
      </div></details>` : `<p class="automation-muted">No tools are configured for this automation.</p>`}
    ${unavailable.length ? `<p class="automation-node-error">${unavailable.length} configured operation${unavailable.length === 1 ? " is" : "s are"} unavailable. Existing selections are preserved until you resolve them.</p>` : ""}
  </fieldset>`;
}

export function updateAgentToolPicker(form) {
  const picker = form?.querySelector("[data-agent-tools]");
  if (!picker) return;
  const query = picker.querySelector("[data-agent-tool-search]")?.value.trim().toLocaleLowerCase() || "";
  const unavailable = Number(picker.dataset.unavailableCount || 0);
  let totalSelected = 0;
  let visiblePlugins = 0;
  for (const plugin of picker.querySelectorAll("[data-agent-plugin]")) {
    const pluginMatches = plugin.dataset.agentSearchName.includes(query);
    let visibleTools = 0;
    for (const tool of plugin.querySelectorAll("[data-agent-tool-group]")) {
      const toolMatches = pluginMatches || tool.dataset.agentSearchName.includes(query);
      let visibleOperations = 0;
      let toolSelected = 0;
      for (const operation of tool.querySelectorAll("[data-agent-operation]")) {
        const checkbox = operation.querySelector("[data-agent-tool]");
        if (checkbox.checked) { totalSelected += 1; toolSelected += 1; }
        operation.querySelector("[data-agent-tool-options]").hidden = !checkbox.checked;
        operation.hidden = Boolean(query) && !toolMatches && !operation.dataset.agentSearchName.includes(query);
        if (!operation.hidden) visibleOperations += 1;
      }
      const operationCount = tool.querySelectorAll("[data-agent-operation]").length;
      tool.querySelector("[data-agent-tool-group-count]").textContent = `${toolSelected} selected · ${operationCount} operation${operationCount === 1 ? "" : "s"}`;
      tool.hidden = visibleOperations === 0;
      if (!tool.hidden) visibleTools += 1;
      if (query && !tool.hidden) tool.open = true;
    }
    plugin.hidden = visibleTools === 0;
    if (!plugin.hidden) visiblePlugins += 1;
  }
  picker.querySelector("[data-agent-tool-count]").textContent = `${totalSelected} selected${unavailable ? ` · ${unavailable} unavailable` : ""}`;
  picker.querySelector("[data-agent-tool-no-results]").hidden = visiblePlugins > 0;
}

function renderAgentEditor(node, catalog, producers) {
  const connected = hasConnectedAutomationResultInput(node);
  return `${producers.length ? `<p class="automation-input-notice" data-input-connection="${connected ? "connected" : "none"}"${connected ? " hidden" : ""}>No earlier step output is connected. Connect an output below if this agent should use it.</p>` : ""}
    ${renderBindingFields(node.inputs, null, { name: "inputs", allowAdd: true, producers })}
    ${renderModelChoice(node, catalog)}
    ${renderReasoningModeField(node.agentMode || "fast", catalog?.models?.find((model) => model.id === node.modelProfileId))}
    <label>Role instructions<textarea name="roleInstructions" dir="auto">${escapeHtml(node.roleInstructions || "")}</textarea></label>
    <label>Prompt<textarea name="prompt" dir="auto" required>${escapeHtml(node.prompt || "")}</textarea></label>
    <details class="automation-node-contract"><summary>Result contract · ${node.result?.kind === "json" ? "Structured JSON" : "Text"}</summary>
      <label>Result<select name="resultKind"><option value="text"${node.result?.kind !== "json" ? " selected" : ""}>Text</option><option value="json"${node.result?.kind === "json" ? " selected" : ""}>Structured JSON</option></select></label>
      <label>JSON schema<textarea name="resultSchema" spellcheck="false">${escapeHtml(node.result?.kind === "json" ? JSON.stringify(node.result.schema, null, 2) : "")}</textarea></label>
      <label>Acceptance checks · JSON array<textarea name="acceptance" spellcheck="false">${escapeHtml(node.acceptance?.length ? JSON.stringify(node.acceptance, null, 2) : "")}</textarea></label>
      <p class="automation-muted">Checks compare declared scalar fields exactly. Leave empty for no acceptance checks.</p></details>
    ${node.savedAgentOrigin ? `<p class="automation-muted">From saved agent ${escapeHtml(node.savedAgentOrigin.agentId)} · revision ${escapeHtml(node.savedAgentOrigin.revision)}</p>` : ""}
    ${renderAgentTools(node, catalog)}`;
}

export function renderAutomationToolInputs(operation, controls = {}, payload, producers = []) {
  if (!operation) return `<p class="automation-muted">Select an operation to configure its inputs.</p>`;
  return `${renderBindingFields(controls, operation.input, { name: "controls", producers })}
    ${operation.payload ? `<p class="automation-muted">${escapeHtml(operation.payload.instructions || "Payload")}</p>${renderBindingFields({ payload }, { properties: { payload: { type: "string" } }, required: ["payload"] }, { name: "payload", producers })}` : ""}`;
}

function renderToolEditor(node, catalog, producers) {
  const operation = selectedOperation(node, catalog);
  const choices = operationChoices(catalog);
  const granted = operation && catalog?.operations?.some((item) => sameOperation(item, operation));
  return `<label>Operation<select name="toolOperation" required><option value=""${operation ? "" : " selected"}>Select an operation</option>
    ${choices.map((item) => `<option value="${escapeHtml(operationIdentity(item))}"${sameOperation(item, node.operation) ? " selected" : ""}>${escapeHtml(`${toolDisplayName(item.toolName)} · ${toolDisplayName(item.operationId)}`)}${requiresFullPlus(item) ? " · FULL+" : ""}</option>`).join("")}</select></label>
    ${node.operation.operationId && !operation ? `<p class="automation-node-error">The saved operation is unavailable. Choose another operation before saving.</p>` : ""}
    ${operation ? `<p class="automation-muted">${escapeHtml(operation.label || operation.operationId)}</p><p class="automation-tool-permission-state" data-granted="${Boolean(granted)}">${granted ? "Allowed for this automation" : `${requiresFullPlus(operation) ? "FULL+" : "Full"} permission needed before publishing`}</p>` : ""}
    <div data-automation-tool-inputs>${renderAutomationToolInputs(operation, node.controls, node.payload, producers)}</div>`;
}

const NODE_ACTION_ICONS = Object.freeze({
  "save-step": '<path d="M4 3h13l3 3v15H4z"/><path d="M8 3v6h8V3M8 21v-8h8v8"/>',
  "move-up": '<path d="m12 4-6 6m6-6 6 6M12 4v16"/>',
  "move-down": '<path d="m12 20-6-6m6 6 6-6M12 20V4"/>',
  parallel: '<path d="M4 4v16M4 12h4m0 0V6h12M8 12v6h12"/>',
  "remove-node": '<path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/>',
});

function renderNodeActionButton(action, label, className = "") {
  return `<button type="button" class="automation-icon-action${className ? ` ${className}` : ""}" data-action="${action}" aria-label="${label}" title="${label}"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${NODE_ACTION_ICONS[action]}</svg></button>`;
}

export function renderAutomationNodeInspector(node, catalog, run = null, producers = [], { dialog = false } = {}) {
  if (run) return renderAutomationNodeDetails(node, run);
  if (!node) return "";
  return `<form data-automation-node-form data-node-id="${escapeHtml(node.id)}">
    <h4>${node.kind === "agent" ? "Agent" : "Tool"} step</h4>
    <label>Step name<input name="title" value="${escapeHtml(node.title || "")}" required dir="auto"></label>
    <label>On failure<select name="onFailure"><option value="stop"${node.onFailure !== "skip" ? " selected" : ""}>Stop process</option><option value="skip"${node.onFailure === "skip" ? " selected" : ""}>Skip step</option></select></label>
    ${node.kind === "agent" ? renderAgentEditor(node, catalog, producers) : renderToolEditor(node, catalog, producers)}
    <div class="automation-inspector-actions" role="group" aria-label="Workflow actions">
      ${dialog ? `<p class="automation-workflow-actions-note">Workflow changes are saved to the draft immediately.</p>` : ""}
      ${dialog ? "" : renderNodeActionButton("save-step", "Save step", "automation-primary")}
      ${renderNodeActionButton("move-up", "Move step earlier in workflow")}
      ${renderNodeActionButton("move-down", "Move step later in workflow")}
      ${renderNodeActionButton("parallel", "Parallel with next")}
      ${renderNodeActionButton("remove-node", "Remove step", "automation-danger")}
      ${node.kind === "agent" ? `<button type="button" class="automation-save-agent" data-action="save-agent">Save as agent</button>` : ""}
    </div>
  </form>`;
}

function selectedAgentTools(form, catalog) {
  const available = Array.isArray(catalog?.grantableOperations)
    ? catalog.grantableOperations : catalog?.operations || [];
  const result = [];
  for (const checkbox of form.querySelectorAll("[data-agent-tool]:checked")) {
    const operation = available.find((item) => operationIdentity(item) === checkbox.dataset.agentTool);
    if (!operation) continue;
    const usage = [...form.querySelectorAll("[data-tool-usage]")]
      .find((item) => item.dataset.toolUsage === checkbox.dataset.agentTool)?.value || "available";
    result.push({ operation: { toolName: operation.toolName, operationId: operation.operationId, contractVersion: operation.contractVersion }, usage });
  }
  return result;
}

export function readAutomationNodePatch(form, node, catalog) {
  const fields = new FormData(form);
  const patch = {
    title: String(fields.get("title") || "").trim(),
    onFailure: fields.get("onFailure") === "skip" ? "skip" : "stop",
  };
  if (node.kind === "agent") {
    patch.modelProfileId = String(fields.get("modelProfileId") || "");
    patch.agentMode = retainedReasoningMode(form, node.agentMode || "fast");
    patch.roleInstructions = String(fields.get("roleInstructions") || "");
    patch.prompt = String(fields.get("prompt") || "");
    patch.inputs = readBindingFields(form, "inputs");
    const resultKind = fields.get("resultKind") === "json" ? "json" : "text";
    if (resultKind === "json") {
      let schema;
      try { schema = JSON.parse(String(fields.get("resultSchema") || "")); }
      catch { throw new Error("Enter a valid JSON result schema."); }
      patch.result = { kind: "json", schema };
    } else patch.result = { kind: "text" };
    const acceptanceText = String(fields.get("acceptance") || "").trim();
    if (resultKind === "json" && acceptanceText) {
      try { patch.acceptance = JSON.parse(acceptanceText); }
      catch { throw new Error("Enter valid JSON acceptance checks."); }
      if (!Array.isArray(patch.acceptance)) throw new Error("Acceptance checks must be a JSON array.");
    } else if (node.acceptance?.length) patch.acceptance = [];
    if (!form.querySelector("[data-agent-tools][data-unavailable]"))
      patch.tools = selectedAgentTools(form, catalog);
  }
  if (node.kind === "tool") {
    const identity = String(fields.get("toolOperation") || "");
    const operation = operationChoices(catalog).find((item) => operationIdentity(item) === identity);
    if (!operation) throw new Error("Select an available operation before saving this step.");
    patch.operation = { toolName: operation.toolName, operationId: operation.operationId,
      contractVersion: operation.contractVersion };
    patch.controls = readBindingFields(form, "controls");
    if (operation.payload) patch.payload = readBindingFields(form, "payload").payload;
    else if (node.payload) patch.payload = null;
  }
  return patch;
}
