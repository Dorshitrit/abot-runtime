import { displayReasoningMode } from "../../lib/reasoning-controls.js";
import { escapeHtml } from "../../lib/text-format.js";
import { renderAutomationToolIdentity } from "./tool-identity.js";
import { renderAutomationFailure } from "./failure-presentation.js";

const CARD_WIDTH = 300;
const BRANCH_GAP = 12;

function graphChildren(node) {
  return Array.isArray(node?.children) ? node.children : [];
}

function graphWidth(node) {
  if (node?.kind === "parallel") {
    const branches = Array.isArray(node.branches) ? node.branches : [];
    return Math.max(CARD_WIDTH, branches.reduce((width, branch) => width + graphWidth(branch), 0)
      + Math.max(0, branches.length - 1) * BRANCH_GAP);
  }
  if (node?.kind === "sequence")
    return Math.max(CARD_WIDTH, ...graphChildren(node).map(graphWidth));
  return CARD_WIDTH;
}

export function findAutomationNode(root, nodeId) {
  if (!root || !nodeId) return null;
  if (root.id === nodeId) return root;
  const descendants = root.kind === "parallel" ? root.branches : root.children;
  for (const child of Array.isArray(descendants) ? descendants : []) {
    const found = findAutomationNode(child, nodeId);
    if (found) return found;
  }
  return null;
}

function nodeRunState(run, nodeId) {
  if (!Array.isArray(run?.nodes)) return null;
  return run.nodes.find((record) => record.nodeId === nodeId) || null;
}

function nodeIsRunning(node, run) {
  if (!node) return false;
  if (nodeRunState(run, node.id)?.status === "running") return true;
  const descendants = node.kind === "parallel" ? node.branches : node.children;
  return Array.isArray(descendants) && descendants.some((child) => nodeIsRunning(child, run));
}

function nodeMetadata(node) {
  if (node.kind === "agent") {
    return [node.modelProfileId || "Model not selected", displayReasoningMode(node.agentMode) || ""].filter(Boolean).join(" · ");
  }
  return [node.operation?.toolName, node.operation?.operationId].filter(Boolean).join(" · ") || "Operation not selected";
}

function leafMarkup(node, context) {
  const record = nodeRunState(context.run, node.id);
  const state = context.run ? record?.status || "pending" : "draft";
  const selected = context.selectedNodeId === node.id;
  const kind = node.kind === "agent" ? "Agent" : "Tool";
  const title = node.title || (node.kind === "agent" ? "New agent" : "New tool step");
  const footer = context.run
    ? state.replaceAll("_", " ")
    : `${node.onFailure === "skip" ? "Skip step" : "Stop process"} on failure`;
  const expanded = selected && Boolean(context.inspectorMarkup);
  return `<button type="button" class="automation-node" data-automation-node="${escapeHtml(node.id)}" data-kind="${kind.toLowerCase()}" data-state="${escapeHtml(state)}" aria-pressed="${selected}"${context.editable ? ` draggable="true" aria-expanded="${expanded}"` : ""}${expanded ? ` aria-controls="automation-step-settings"` : ""}>
    <span class="automation-node-top"><span>${kind}</span><span>${escapeHtml(state)}</span></span>
    <strong dir="auto">${escapeHtml(title)}</strong>${node.kind === "tool"
      ? renderAutomationToolIdentity(node.operation, context.catalog)
      : `<small dir="auto">${escapeHtml(nodeMetadata(node))}</small>`}
    <span class="automation-node-foot">${escapeHtml(footer)}</span></button>`;
}

function connectorMarkup(sequenceId, index, context, nextNode = null, firstStep = false) {
  if (!context.editable)
    return `<span class="automation-connector" data-active="${nodeIsRunning(nextNode, context.run)}" aria-hidden="true"></span>`;
  if (firstStep)
    return `<button type="button" class="automation-connector automation-drop-target automation-first-step" data-insert-parent="${escapeHtml(sequenceId)}" data-insert-index="${index}" aria-label="Choose a tool or agent for the first step" aria-pressed="false"><span class="automation-first-step-icon" aria-hidden="true">+</span><span class="automation-first-step-copy"><strong>Add first step</strong><small data-insert-help>Choose from Tools or Agents, or drag here</small></span></button>`;
  return `<button type="button" class="automation-connector automation-drop-target" data-insert-parent="${escapeHtml(sequenceId)}" data-insert-index="${index}" aria-label="Add step at position ${index + 1}"><span aria-hidden="true">+</span></button>`;
}

function sequenceMarkup(sequence, context, branch = false) {
  const children = graphChildren(sequence);
  if (!children.length) return `<div class="automation-sequence${branch ? " automation-branch-sequence" : ""}">${connectorMarkup(sequence.id, 0, context, null, !branch)}</div>`;
  return `<div class="automation-sequence${branch ? " automation-branch-sequence" : ""}">${children.map((child, index) => {
    const markup = child.kind === "parallel"
      ? parallelMarkup(child, context)
      : leafMarkup(child, context);
    const inspector = context.editable && context.inspectorMarkup && child.kind !== "parallel" && child.id === context.selectedNodeId
      ? `<div class="automation-inline-inspector-frame"><div class="automation-inline-inspector-clip">${context.inspectorMarkup}</div></div>` : "";
    const side = index % 2 === 0 ? "left" : "right";
    return `${index === 0 ? connectorMarkup(sequence.id, 0, context, child) : ""}<div class="automation-sequence-item" data-graph-item="${escapeHtml(child.id)}" data-graph-kind="${escapeHtml(child.kind)}" data-side="${side}">${markup}${inspector}</div>${connectorMarkup(sequence.id, index + 1, context, children[index + 1])}`;
  }).join("")}</div>`;
}

function parallelMarkup(group, context) {
  const branches = Array.isArray(group.branches) ? group.branches : [];
  const widths = context.editable ? branches.map(graphWidth) : [];
  const totalWidth = widths.reduce((width, branchWidth) => width + branchWidth, 0)
    + Math.max(0, widths.length - 1) * BRANCH_GAP;
  const groupStyle = context.editable ? ` style="width:${Math.max(CARD_WIDTH, totalWidth)}px"` : "";
  const branchStyle = context.editable
    ? ` style="grid-template-columns:${widths.map((width) => `${width}px`).join(" ")};--first-branch-width:${widths[0] || CARD_WIDTH}px;--last-branch-width:${widths.at(-1) || CARD_WIDTH}px"`
    : ` style="--automation-branch-count:${branches.length}"`;
  return `<div class="automation-parallel" role="group" aria-label="Parallel steps, all branches join before continuing"${groupStyle}>
    <span class="automation-fork" aria-hidden="true"></span>
    <div class="automation-branches-viewport" data-branches-for="${escapeHtml(group.id)}"><div class="automation-branches"${branchStyle}>${branches.map((branch, index) =>
      `<div class="automation-branch" role="group" aria-label="Branch ${index + 1} of ${branches.length}"><span class="automation-branch-label">Branch ${index + 1}</span>${sequenceMarkup(branch, context, true)}</div>`
    ).join("")}</div></div>
    <div class="automation-join">Join · after every branch</div>
  </div>`;
}

export function renderAutomationTimeline(definition, options = {}) {
  const body = definition?.body;
  if (!body || body.kind !== "sequence") return `<p class="automation-empty-graph">No steps have been added.</p>`;
  const trigger = definition.trigger?.kind || "manual";
  const context = { run: options.run || null, selectedNodeId: options.selectedNodeId || "", editable: options.editable === true, inspectorMarkup: options.inspectorMarkup || "", catalog: options.catalog };
  const timeline = `<div class="automation-timeline${context.editable ? " automation-camera-scene" : ""}" data-mode="${context.run ? "run" : "editor"}"${context.editable ? ` data-camera-scene data-scene-min-width="${graphWidth(body)}"` : ""}>
    <div class="automation-origin">Start · ${escapeHtml(trigger)}</div>
    ${sequenceMarkup(body, context)}
    <div class="automation-finish">Final report</div>
  </div>`;
  if (!context.editable) return timeline;
  return `<div class="automation-camera"><span class="automation-camera-level" data-camera-level aria-live="polite">100%</span><div class="automation-camera-viewport" data-camera-viewport tabindex="0" aria-label="Workflow canvas. Use the mouse wheel or plus and minus keys to zoom, drag empty space to pan, and press zero to reset.">${timeline}</div></div>`;
}

export function renderAutomationNodeDetails(node, run = null) {
  if (!node) return `<div class="automation-inspector-empty">Select a step to see its details.</div>`;
  const record = nodeRunState(run, node.id);
  const operation = node.kind === "tool"
    ? `<dt>Operation</dt><dd>${escapeHtml(nodeMetadata(node))}</dd>`
    : `<dt>Model</dt><dd>${escapeHtml(node.modelProfileId || "Not selected")}</dd><dt>Role</dt><dd>${escapeHtml(displayReasoningMode(node.agentMode) || "Not selected")}</dd>`;
  const prompt = node.kind === "agent" && node.prompt
    ? `<div class="automation-inspector-prompt"><strong>Prompt</strong><p dir="auto">${escapeHtml(node.prompt)}</p></div>`
    : "";
  const error = record?.errorCode
    ? `${renderAutomationFailure(record.errorCode, run)}<details class="automation-effect-diagnostics"><summary>Technical error</summary><code>${escapeHtml(record.errorCode)}</code></details>`
    : "";
  return `<div class="automation-inspector-summary"><h3 dir="auto">${escapeHtml(node.title || "Untitled step")}</h3>
    <dl><dt>Type</dt><dd>${node.kind === "agent" ? "Agent" : "Tool"}</dd>${operation}
    <dt>Failure</dt><dd>${node.onFailure === "skip" ? "Skip step" : "Stop process"}</dd>
    ${run ? `<dt>Status</dt><dd>${escapeHtml(record?.status || "Pending")}</dd>` : ""}</dl>${prompt}${error}</div>`;
}
