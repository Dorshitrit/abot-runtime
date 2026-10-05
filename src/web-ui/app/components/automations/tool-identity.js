import { escapeHtml } from "../../lib/text-format.js";

export function toolDisplayName(name) {
  return String(name || "").split(/[_\s-]+/u).filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");
}

export function automationCatalogOperation(reference, catalog) {
  const operations = catalog?.grantableOperations || catalog?.operations || [];
  return operations.find((item) => item.toolName === reference?.toolName &&
    item.operationId === reference?.operationId && item.contractVersion === reference?.contractVersion) || null;
}

/** Keep configured identity distinct from the user-authored step name. */
export function renderAutomationToolIdentity(reference, catalog, { showPlugin = false } = {}) {
  const operation = automationCatalogOperation(reference, catalog);
  const tool = toolDisplayName(reference?.toolName) || "Tool not selected";
  const action = toolDisplayName(reference?.operationId) || "Choose an operation";
  const exact = [reference?.toolName, reference?.operationId].filter(Boolean).join(" · ");
  return `<span class="automation-tool-identity" title="${escapeHtml(exact)}">
    <span class="automation-tool-identity-name" dir="auto">${escapeHtml(tool)}</span>
    <span class="automation-tool-identity-operation" dir="auto">${escapeHtml(action)}</span>
    ${showPlugin && operation?.pluginName ? `<span class="automation-tool-identity-plugin" dir="auto">${escapeHtml(toolDisplayName(operation.pluginName))}</span>` : ""}
  </span>`;
}
