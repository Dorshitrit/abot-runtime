import { escapeHtml } from "../../lib/text-format.js";
import { automationCatalogOperation, renderAutomationToolIdentity } from "./tool-identity.js";

function compact(value, limit = 180) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function sourceLabel(binding, producers) {
  if (!binding) return "Not configured";
  const producer = producers.find((item) => item.id === (binding.nodeId || binding.parallelNodeId));
  if (binding.kind === "node_result")
    return `${producer?.title || "Unavailable step"} · ${binding.select === "data" ? "data" : "text"}${binding.pointer ? ` · ${binding.pointer}` : ""}`;
  if (binding.kind === "branch_results") return `${producer?.title || "Parallel group"} · all branch results`;
  if (binding.kind === "run_input") return `Run input · ${binding.input}`;
  if (binding.kind === "run_file") return `New file each run · ${binding.fileName}`;
  if (binding.kind === "source_files") return "All input files";
  if (binding.kind === "source_file") return `Input file ${Number(binding.index || 0) + 1}`;
  if (binding.kind === "literal")
    return compact(typeof binding.value === "string" ? binding.value : JSON.stringify(binding.value), 90) || "Empty value";
  return "Not configured";
}

function inputPreview(node, producers) {
  const entries = Object.entries(node.kind === "agent" ? node.inputs || {} : node.controls || {});
  if (node.kind === "tool" && node.payload) entries.push(["Payload", node.payload]);
  if (!entries.length) return `<p class="automation-muted">No inputs configured.</p>`;
  return `<dl class="automation-step-preview-inputs">${entries.slice(0, 3).map(([name, binding]) =>
    `<dt dir="auto">${escapeHtml(name)}</dt><dd dir="auto">${escapeHtml(sourceLabel(binding, producers))}</dd>`).join("")}</dl>
    ${entries.length > 3 ? `<p class="automation-muted">+${entries.length - 3} more inputs in the editor</p>` : ""}`;
}

export function renderAutomationStepPreview(node, catalog, producers = []) {
  if (!node || !["agent", "tool"].includes(node.kind)) return "";
  const operation = node.kind === "tool" ? automationCatalogOperation(node.operation, catalog) : null;
  const description = node.kind === "agent" ? node.prompt || "Add instructions for this agent." : operation?.toolDescription;
  const output = node.kind === "agent" ? node.result?.kind === "json" ? "Structured JSON" : "Text" : "Tool result";
  const checks = node.acceptance?.length || 0;
  return `<section class="automation-inspector automation-inline-inspector automation-step-preview" id="automation-step-settings" aria-labelledby="automation-step-preview-title">
    <div class="automation-inline-inspector-heading"><h4 id="automation-step-preview-title">Step preview</h4><button type="button" class="automation-text-button" data-select-node="" aria-label="Close step preview">Close</button></div>
    ${node.kind === "tool" ? renderAutomationToolIdentity(node.operation, catalog, { showPlugin: true }) : ""}
    ${description ? `<p class="automation-step-preview-description" dir="auto">${escapeHtml(compact(description))}</p>` : ""}
    <h5>Inputs</h5>${inputPreview(node, producers)}
    <div class="automation-step-preview-output"><strong>Output</strong><span>${escapeHtml(output)}${checks ? ` · ${checks} acceptance check${checks === 1 ? "" : "s"}` : ""}</span></div>
    ${node.kind === "agent" ? `<p class="automation-muted">${node.tools?.length || 0} tool operations available</p>` : ""}
    <button type="button" class="automation-primary automation-step-edit-button" data-action="edit-step" aria-haspopup="dialog">Edit step</button>
  </section>`;
}
