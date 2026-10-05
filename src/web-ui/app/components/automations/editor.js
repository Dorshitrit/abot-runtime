import { escapeHtml } from "../../lib/text-format.js";
import { findAutomationNode, renderAutomationTimeline } from "./timeline.js";
import { operationIdentity } from "./node-inspector.js";
import { renderAutomationStepPreview } from "./step-preview.js";
import { renderAutomationEditorActions } from "./editor-actions.js";
import { toolDisplayName } from "./tool-identity.js";
export { toolDisplayName } from "./tool-identity.js";
import { listAvailableAutomationProducers } from "../../lib/automation-binding-producers.js";
import { requiresFullPlus, selectedAutomationOperations } from "./permission-selection.js";

function triggerChoice(trigger) {
  return trigger?.kind === "schedule" ? trigger.schedule?.kind || "daily" : trigger?.kind || "manual";
}

function renderTriggerFields(definition) {
  const selected = triggerChoice(definition.trigger);
  const schedule = definition.trigger?.schedule || {};
  return `<div class="automation-trigger-fields"><label>Start<select name="triggerKind">
    ${[["manual","Manual"],["folder","New files"],["timer","After delay"],["once","Once"],["interval","Interval"],["daily","Daily"],["weekly","Weekly"],["monthly","Monthly"]].map(([kind,label]) => `<option value="${kind}"${selected === kind ? " selected" : ""}>${label}</option>`).join("")}</select></label>
    <label>Time or minutes<input name="triggerValue" value="${escapeHtml(selected === "interval" ? Math.round((schedule.everyMs || 3_600_000) / 60_000) : selected === "timer" ? Math.round((schedule.delayMs || 60_000) / 60_000) : selected === "once" ? schedule.at || "" : schedule.at || "09:00")}" placeholder="09:00 or minutes"></label>
    <label>Weekdays (0–6)<input name="weekdays" value="${escapeHtml((schedule.weekdays || []).join(","))}" placeholder="1,2,3,4,5"></label>
    <label>Day of month<input name="dayOfMonth" type="number" min="1" max="31" value="${escapeHtml(schedule.dayOfMonth || 1)}"></label>
    <label>Minimum new files<input name="minimumEligibleFiles" type="number" min="1" value="${escapeHtml(definition.trigger?.minimumEligibleFiles || 1)}"></label>
    <label>Check every (minutes)<input name="checkEveryMinutes" type="number" min="1" value="${escapeHtml(Math.round((definition.trigger?.checkEveryMs || 300_000) / 60_000))}"></label>
  </div>`;
}

function renderSourceFields(source) {
  return `<details class="automation-source"${source ? " open" : ""}><summary>Folder source · optional</summary>
    <div class="automation-source-options">
      <label><input type="checkbox" name="sourceEnabled"${source ? " checked" : ""}>Use a folder</label>
      <label><input type="checkbox" name="sourceRecursive"${source?.recursive ? " checked" : ""}>Include subfolders</label>
      <label><input type="checkbox" name="includeExisting"${source?.includeExisting ? " checked" : ""}>Include files already there on first activation</label>
    </div><div class="automation-source-fields"><label>Runtime-visible folder<input name="sourcePath" value="${escapeHtml(source?.location?.path || "")}" placeholder="/workspace/inbox"></label>
      <label>Process<select name="sourceMode"><option value="per_file"${source?.mode !== "batch" ? " selected" : ""}>Each file</option><option value="batch"${source?.mode === "batch" ? " selected" : ""}>Batch</option></select></label>
      <label>Max files per batch<input type="number" name="maxBatchFiles" min="1" max="100" value="${escapeHtml(source?.maxBatchFiles || 100)}"></label>
      <label>Include patterns<input name="includePatterns" value="${escapeHtml((source?.includePatterns || []).join(", "))}" placeholder="*.pdf, *.txt"></label>
      <label>Exclude outputs and archive paths<input name="excludePatterns" value="${escapeHtml((source?.excludePatterns || []).join(", "))}" placeholder="archive/**, output/**"></label>
    </div><p class="automation-muted">The Runtime must be able to read this folder. If a step writes or archives files, exclude those destinations so they cannot become new inputs. Publishing never starts processing existing files by itself.</p>
  </details>`;
}

function renderLimits(limits) {
  if (!limits) return "";
  return `<details class="automation-limits"><summary>Resource limits</summary><div class="automation-limit-fields">
    ${[["maxModelCallsPerRun","Model calls / run"],["maxToolCallsPerRun","Tool calls / run"],["maxConcurrentNodes","Parallel steps"],["maxRunsPerDay","Runs / day"],["maxRunDurationMs","Run duration (ms)"],["maxStoredArtifactBytes","Stored artifacts (bytes)"],["stopReportDeadlineMs","Stop report deadline (ms)"]].map(([key,label]) => `<label>${label}<input type="number" min="1" name="limit-${key}" value="${escapeHtml(limits[key])}"${key === "maxModelCallsPerRun" ? ` aria-describedby="automation-model-limit-help"` : ""}></label>`).join("")}
  </div><p class="automation-muted" id="automation-model-limit-help">Model calls include decisions, tool discovery, input preparation and final responses across the whole run. This limit is a ceiling, not the desired number of calls. Usage varies by model and workflow; use completed-run usage in Execution details to choose headroom. Tool calls count admitted attempts, including failed attempts.</p>
  <p class="automation-muted">Save the draft and publish to apply changed limits to future runs. An existing run keeps its published limits.</p></details>`;
}

function toolCatalogItems(catalog) {
  const operations = Array.isArray(catalog?.grantableOperations)
    ? catalog.grantableOperations : catalog?.operations || [];
  const tools = new Map();
  for (const operation of operations) {
    const existing = tools.get(operation.toolName) || {
      name: operation.toolName,
      label: toolDisplayName(operation.toolName),
      group: operation.pluginName || "Built-in",
      description: operation.toolDescription || "",
      operations: [],
    };
    existing.operations.push(operation);
    tools.set(operation.toolName, existing);
  }
  return [...tools.values()].sort((left, right) =>
    left.group.localeCompare(right.group) || left.label.localeCompare(right.label));
}

export function renderAutomationToolResults(catalog, { query = "", selectedToolName = "" } = {}) {
  const normalized = query.trim().toLocaleLowerCase();
  const tools = toolCatalogItems(catalog).filter((tool) => !normalized ||
    [tool.label, tool.name, tool.group, tool.description,
      ...tool.operations.map((operation) => `${operation.operationId} ${operation.label || ""}`)]
      .some((value) => value.toLocaleLowerCase().includes(normalized)));
  if (!tools.length) return `<p class="automation-muted">${normalized ? "No matching tools." : "No tools are configured yet. You can still build with agents."}</p>`;
  const granted = new Set((catalog?.operations || []).map((item) =>
    operationIdentity(item)));
  const groups = new Map();
  for (const tool of tools) {
    if (!groups.has(tool.group)) groups.set(tool.group, []);
    groups.get(tool.group).push(tool);
  }
  return [...groups.entries()].map(([group, entries]) => {
    const expanded = Boolean(normalized || entries.some((tool) => tool.name === selectedToolName));
    const operationCount = entries.reduce((count, tool) => count + tool.operations.length, 0);
    return `<details class="automation-tool-group"${expanded ? " open" : ""}><summary><strong>${escapeHtml(toolDisplayName(group))}</strong><small>${entries.length} ${entries.length === 1 ? "tool" : "tools"} · ${operationCount} ${operationCount === 1 ? "operation" : "operations"}</small></summary><div class="automation-plugin-tools">${entries.map((tool) => {
    const selected = tool.name === selectedToolName;
    return `<div class="automation-tool-choice"><button type="button" draggable="true" class="automation-palette-item" data-palette-select-tool="${escapeHtml(tool.name)}" data-palette-tool="${escapeHtml(tool.name)}" aria-expanded="${selected}">${escapeHtml(tool.label)}<small>${escapeHtml(tool.operations.length)} ${tool.operations.length === 1 ? "operation" : "operations"}</small></button>
      ${selected ? `<div class="automation-tool-operations"><p>Choose the operation and inputs after adding this tool.</p>${tool.operations.map((operation) => {
        const identity = operationIdentity(operation);
        const allowed = granted.has(identity);
        return `<div class="automation-tool-operation"><strong>${escapeHtml(toolDisplayName(operation.operationId))}</strong><span>${requiresFullPlus(operation) ? "FULL+" : "Full"}${allowed ? "" : " · permission needed"}</span><small>${escapeHtml(operation.label || "")}</small></div>`;
      }).join("")}<button type="button" class="automation-tool-add" data-palette-add-tool="${escapeHtml(tool.name)}">Add to timeline</button></div>` : ""}</div>`;
  }).join("")}</div></details>`;
  }).join("");
}

function paletteAgent(item) {
  return `<button type="button" draggable="true" class="automation-palette-item automation-agent-choice" data-palette-agent="${escapeHtml(item.agentId || item.id)}"><strong dir="auto">${escapeHtml(item.agent?.title || item.title || "Saved agent")}</strong><small>Saved agent · revision ${escapeHtml(item.revision || 1)}</small></button>`;
}

function renderValidation(validation) {
  const issues = Array.isArray(validation?.issues) ? validation.issues : [];
  if (!issues.length) return "";
  return `<div class="automation-validation" role="alert"><strong>Needs attention before publishing</strong>${issues.map((issue) => `<button type="button" data-select-node="${escapeHtml(issue.nodeId || "")}"><code>${escapeHtml(issue.code || "automation_graph_invalid")}</code>${issue.path ? ` · <code>${escapeHtml(issue.path)}</code>` : ""} · ${escapeHtml(issue.message || "Check this step")}</button>`).join("")}</div>`;
}

function renderToolPermissionRequirements(selection) {
  let requirement = "";
  if (selection.operations.length) {
    const operations = selection.details.map((operation) => `<li><span>${escapeHtml(toolDisplayName(operation.toolName))} · ${escapeHtml(toolDisplayName(operation.operationId))}</span><strong>${requiresFullPlus(operation) ? "FULL+" : "Full"}</strong></li>`).join("");
    requirement = `<ul class="automation-permission-list">${operations}</ul>`;
  } else if (!selection.missing.length) {
    requirement = `<p>No tool operations selected.</p>`;
  }
  const count = selection.operations.length;
  const state = `${selectedToolPermissionLabel(selection)}${count ? ` · ${count} selected operation${count === 1 ? "" : "s"}` : ""}${selection.missing.length ? ` · ${selection.missing.length} unavailable` : ""}`;
  return `<details class="automation-permission"><summary>Tool permission <span class="automation-permission-state">${escapeHtml(state)}</span></summary>
    ${requirement}
    ${selection.missing.length ? `<p>${selection.missing.length} selected operation${selection.missing.length === 1 ? " is" : "s are"} unavailable in the current tool catalog.</p>` : ""}
  </details>`;
}

function selectedToolPermissionLabel(selection) {
  if (!selection.operations.length && selection.missing.length) return "Selected tool unavailable";
  if (!selection.operations.length) return "No tools selected";
  return selection.mode === "full_plus" ? "FULL+ required" : "Full required";
}

export function renderAutomationEditor(snapshot, paletteState = {}) {
  const definition = snapshot.draft?.definition;
  if (!definition) return `<p class="automation-feedback" role="status">${escapeHtml(snapshot.error || "Loading draft…")}</p>`;
  const selected = findAutomationNode(definition.body, snapshot.selectedNodeId);
  const producers = listAvailableAutomationProducers(definition.body, snapshot.selectedNodeId);
  const catalog = snapshot.catalog || { operations: [], models: [], savedAgents: [] };
  const current = snapshot.automations.find((item) => item.id === snapshot.selectedAutomationId);
  const published = Boolean(current?.publishedRevision);
  const archived = current?.status === "archived" || Boolean(snapshot.draft?.archivedAt);
  const runUnavailable = published && current?.canRun === false;
  const activateUnavailable = published && current?.status !== "active" && current?.canActivate === false;
  const selectedOperations = selectedAutomationOperations(definition, catalog);
  const permission = selectedToolPermissionLabel(selectedOperations);
  const inspectorMarkup = !archived ? renderAutomationStepPreview(selected, catalog, producers) : "";
  return `<div class="automation-workspace" data-automation-view="editor">
    <section class="automation-definition-panel" aria-label="Automation details">
    <div class="automation-heading"><div><button type="button" class="automation-text-button" data-action="back">← All automations</button><h3 dir="auto">${escapeHtml(definition.title || "ABot Automation")}</h3><p>Draft revision ${escapeHtml(snapshot.draft.revision)}${published ? ` · Published revision ${escapeHtml(current.publishedRevision)}` : " · Not published"}${archived ? " · Archived" : ""}</p></div>
      <div class="automation-heading-actions"><button type="button" class="automation-details-toggle" data-action="toggle-details" aria-controls="automation-editor-details" aria-expanded="true"><span data-details-label>Collapse details</span></button></div></div>
    ${renderAutomationEditorActions(snapshot, { current: archived ? { ...current, status: "archived" } : current, canDeleteDraft: current && !snapshot.publishedDefinition, runUnavailable, activateUnavailable })}
    ${!archived && (runUnavailable || activateUnavailable) ? `<p class="automation-action-note" role="status">${escapeHtml(current.runUnavailableReason || current.activateUnavailableReason || "This automation cannot start yet.")}</p>` : ""}
    <p class="automation-feedback" role="status" aria-live="polite" data-tone="${snapshot.error ? "error" : ""}">${escapeHtml(snapshot.error || snapshot.feedback || (archived ? "Archived. Restore to edit or run it. Reports remain available." : "Step and order changes are saved to the draft immediately. Automation settings use Save draft. Publishing is separate."))}</p>
    <div class="automation-editor-details" id="automation-editor-details">
    <div class="automation-tabs" role="tablist"><button type="button" role="tab" aria-selected="true">Editor</button><button type="button" role="tab" aria-selected="false" data-action="show-runs">Runs (${escapeHtml(snapshot.runs.length)})</button></div>
    <div class="automation-summary"><span><strong>Start</strong> · ${escapeHtml(triggerChoice(definition.trigger))}</span><span><strong>Permission</strong> · ${permission}</span><span><strong>Model</strong> · Per agent</span></div>
    ${renderValidation(!archived && snapshot.validationVisible ? snapshot.validation : null)}
    <form class="automation-definition-form" data-automation-definition-form${archived ? " inert" : ""}><div class="automation-top-fields"><label>Name<input name="title" value="${escapeHtml(definition.title || "")}" required dir="auto"></label><label>Goal<textarea name="objective" dir="auto">${escapeHtml(definition.objective || "")}</textarea></label></div>
      <label>Working directory<input name="workingDirectory" value="${escapeHtml(definition.workingDirectory || "")}" placeholder="Optional absolute path on the Runtime host"></label>
      <details class="automation-run-inputs"><summary>Run inputs · JSON object</summary><label>Values supplied when a run starts<textarea name="inputsJson" spellcheck="false">${escapeHtml(JSON.stringify(definition.inputs || {}, null, 2))}</textarea></label></details>
      ${renderTriggerFields(definition)}${renderSourceFields(definition.source)}${renderLimits(definition.limits)}
      ${renderToolPermissionRequirements(selectedOperations)}
    </form>
    </div>
    </section>
    ${archived ? `<section class="automation-canvas automation-archived-canvas" aria-label="Workflow">${renderAutomationTimeline(definition, { editable: false, catalog })}</section>` : `<div class="automation-editor-layout"><div class="automation-editor-sidebar"><section class="automation-palette" aria-label="Agents"><h4>Agents</h4><p>Add a new agent or reuse one you saved.</p>
        <button type="button" draggable="true" class="automation-palette-item automation-agent-choice" data-palette-agent="new"><strong>New agent</strong><small>Set model, role, and prompt</small></button>
        ${(catalog.savedAgents || []).map(paletteAgent).join("")}
      </section><section class="automation-palette" aria-label="Tools"><h4>Tools</h4><p>Open a plugin to choose a tool.</p>
      <label class="automation-tool-search">Search plugins, tools, or operations<input type="search" data-tool-search value="${escapeHtml(paletteState.query || "")}" placeholder="Search plugins or tools" autocomplete="off"></label>
      <div data-automation-tool-results>${renderAutomationToolResults(catalog, paletteState)}</div>
      <button type="button" data-action="move-to-slot" hidden>Move selected step here</button></section>
      </div><section class="automation-canvas" aria-label="Workflow">${renderAutomationTimeline(definition, { editable: true, selectedNodeId: snapshot.selectedNodeId, inspectorMarkup, catalog })}</section></div>`}
  </div>`;
}

function commaValues(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function readTrigger(fields) {
  const kind = String(fields.get("triggerKind") || "manual");
  if (kind === "manual") return { kind };
  if (kind === "folder") return {
    kind, checkEveryMs: Number(fields.get("checkEveryMinutes")) * 60_000,
    minimumEligibleFiles: Number(fields.get("minimumEligibleFiles")),
  };
  const value = String(fields.get("triggerValue") || "").trim();
  if (kind === "timer") return { kind: "schedule", schedule: { kind, delayMs: Number(value) * 60_000 } };
  if (kind === "interval") return { kind: "schedule", schedule: { kind, everyMs: Number(value) * 60_000 } };
  if (kind === "weekly") return { kind: "schedule", schedule: { kind, at: value, weekdays: commaValues(String(fields.get("weekdays") || "")).map(Number) } };
  if (kind === "monthly") return { kind: "schedule", schedule: { kind, at: value, dayOfMonth: Number(fields.get("dayOfMonth")) } };
  return { kind: "schedule", schedule: { kind, at: value } };
}

export function readAutomationDefinitionPatch(form, definition) {
  const fields = new FormData(form);
  let inputs;
  try { inputs = JSON.parse(String(fields.get("inputsJson") || "{}")); }
  catch { throw new Error("Run inputs must be valid JSON."); }
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs))
    throw new Error("Run inputs must be a JSON object.");
  const sourceEnabled = fields.has("sourceEnabled");
  const source = sourceEnabled ? {
    sourceId: definition.source?.sourceId || "",
    location: { kind: "runtime_path", path: String(fields.get("sourcePath") || "").trim() },
    includePatterns: commaValues(String(fields.get("includePatterns") || "")),
    excludePatterns: commaValues(String(fields.get("excludePatterns") || "")),
    recursive: fields.has("sourceRecursive"), includeExisting: fields.has("includeExisting"),
    mode: fields.get("sourceMode") === "batch" ? "batch" : "per_file",
    maxBatchFiles: Number(fields.get("maxBatchFiles")),
  } : null;
  const limits = { ...definition.limits };
  for (const key of Object.keys(limits)) limits[key] = Number(fields.get(`limit-${key}`));
  return {
    title: String(fields.get("title") || "").trim(), objective: String(fields.get("objective") || "").trim(),
    workingDirectory: String(fields.get("workingDirectory") || "").trim() || null,
    trigger: readTrigger(fields), source, inputs, limits,
  };
}
