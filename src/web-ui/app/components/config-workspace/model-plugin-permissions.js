import { escapeAttribute, escapeHtml } from "../../lib/text-format.js";
import {
  modelPluginRulesNeedRepair,
  projectModelPluginSelection,
} from "./model-plugin-selection.js";

export async function loadModelPluginCatalog(loadPlugins) {
  if (!loadPlugins) return null;
  try {
    const snapshot = await loadPlugins();
    return { plugins: snapshot.plugins || [], error: "" };
  } catch (error) {
    return {
      plugins: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function modelLabel(file) {
  return file.config.label || file.id;
}

function renderCapabilitySwitch(file, plugin, capability) {
  const reason = capability.blockedReason;
  const reasonId = `model-tool-policy-${encodeURIComponent(file.id)}-${encodeURIComponent(plugin.id)}-${encodeURIComponent(capability.id)}`;
  return `<li class="plugin-capability-row">
    <div class="plugin-capability-copy">
      <code>${escapeHtml(capability.id)}</code>
      ${capability.description ? `<p class="plugin-capability-description" title="${escapeAttribute(capability.description)}">${escapeHtml(capability.description)}</p>` : ""}
      ${reason ? `<p class="plugin-capability-policy" id="${escapeAttribute(reasonId)}">${escapeHtml(reason)}</p>` : ""}
    </div>
    <label class="plugin-capability-switch">
      <input type="checkbox" role="switch" data-config-action="model-plugin-capability-enabled"
        data-kind="model" data-id="${escapeAttribute(file.id)}"
        data-plugin-id="${escapeAttribute(plugin.id)}" data-capability-id="${escapeAttribute(capability.id)}"
        aria-label="${escapeAttribute(`Allow ${capability.id} in ${plugin.id} for ${modelLabel(file)}`)}"
        ${reason ? `aria-describedby="${escapeAttribute(reasonId)}" disabled` : ""}
        ${capability.enabled ? "checked" : ""} />
      <span aria-hidden="true"></span>
    </label>
  </li>`;
}

function renderPluginRow(file, plugin, globalPlugin, viewState) {
  const key = JSON.stringify([file.id, plugin.id]);
  const open = viewState.expandedPlugins?.has(key);
  const count = plugin.capabilities.length;
  const reason = plugin.controlBlockedReason;
  const pluginIdentity = `${encodeURIComponent(file.id)}-${encodeURIComponent(plugin.id)}`;
  const summaryId = `model-plugin-summary-${pluginIdentity}`;
  const reasonId = `model-plugin-policy-${pluginIdentity}`;
  const globallyRestricted = ["partial", "disabled"].includes(
    globalPlugin.state,
  );
  return `<article class="model-plugin-row">
    <details data-model-plugin-details="${escapeAttribute(plugin.id)}" data-model-id="${escapeAttribute(file.id)}" ${open ? "open" : ""}>
      <summary id="${escapeAttribute(summaryId)}">
        <span class="model-plugin-name" title="${escapeAttribute(plugin.id)}">${escapeHtml(plugin.id)}</span>
        <span class="model-plugin-row-status">
          ${globallyRestricted ? '<span class="model-plugin-global-note">Global restrictions</span>' : ""}
          <span class="plugin-selection-state" data-plugin-state="${escapeAttribute(plugin.state)}">${plugin.selectedCapabilityCount}/${count} tools</span>
        </span>
      </summary>
      <div class="model-plugin-details-body">
        ${plugin.description ? `<p class="model-plugin-description">${escapeHtml(plugin.description)}</p>` : ""}
        ${reason ? `<p class="plugin-capability-policy model-plugin-policy" id="${escapeAttribute(reasonId)}">${escapeHtml(reason)}</p>` : ""}
        <ul class="plugin-capability-list model-plugin-capability-list" aria-label="${escapeAttribute(`Tools in ${plugin.id} for ${modelLabel(file)}`)}">
          ${count ? plugin.capabilities.map((capability) => renderCapabilitySwitch(file, plugin, capability)).join("") : '<li class="plugin-capability-empty">This plugin does not expose any tools.</li>'}
        </ul>
      </div>
    </details>
    <label class="plugin-capability-switch model-plugin-master-switch" title="${escapeAttribute(reason || `Allow ${plugin.id} for this model`)}">
      <input type="checkbox" role="switch" data-config-action="model-plugin-enabled"
        data-kind="model" data-id="${escapeAttribute(file.id)}" data-plugin-id="${escapeAttribute(plugin.id)}"
        aria-label="${escapeAttribute(`Allow ${plugin.id} for ${modelLabel(file)}`)}"
        ${reason ? `aria-describedby="${escapeAttribute(reasonId)}" disabled` : ""}
        ${plugin.pluginEnabled ? "checked" : ""} />
      <span aria-hidden="true"></span>
    </label>
  </article>`;
}

function renderSavedRules(file, viewState) {
  const denied = file.config.plugins?.deny || [];
  if (!denied.length) return "";
  const open = viewState.expandedRetainedRules?.has(file.id);
  return `<details class="model-plugin-saved-rules" data-model-plugin-retained="${escapeAttribute(file.id)}" ${open ? "open" : ""}>
    <summary>Saved rules <span>${denied.length}</span></summary>
    <p>Rules without an editable switch can be changed in the model configuration file shown above.</p>
    <ul>${denied.map((selector) => `<li><code>${escapeHtml(selector)}</code></li>`).join("")}</ul>
  </details>`;
}

export function renderModelPluginPermissions(file, catalog, viewState = {}) {
  if (!catalog) return "";
  const open = catalog.error || viewState.expandedSections?.has(file.id);
  const summaryId = `model-plugin-access-${encodeURIComponent(file.id)}`;
  if (modelPluginRulesNeedRepair(file.config)) {
    return `<details class="model-plugin-permissions" data-model-plugin-section="${escapeAttribute(file.id)}" open>
      <summary id="${escapeAttribute(summaryId)}">Plugin access</summary>
      <p class="error-text">Repair plugins.deny in the model configuration file shown above before changing model plugin restrictions.</p>
    </details>`;
  }
  const plugins = catalog.plugins.map((plugin) =>
    projectModelPluginSelection(file.config, plugin, catalog.plugins),
  );
  const selectedCount = plugins.reduce(
    (count, plugin) => count + plugin.selectedCapabilityCount,
    0,
  );
  const capabilityCount = plugins.reduce(
    (count, plugin) => count + plugin.capabilities.length,
    0,
  );
  return `<details class="model-plugin-permissions" data-model-plugin-section="${escapeAttribute(file.id)}" aria-label="${escapeAttribute(`Plugin access for ${modelLabel(file)}`)}" ${open ? "open" : ""}>
    <summary id="${escapeAttribute(summaryId)}">
      <span>Plugin access</span>
      <span class="model-plugin-summary-count">${plugins.length} plugins · ${selectedCount}/${capabilityCount} tools available</span>
    </summary>
    <div class="model-plugin-permissions-body">
      <p class="model-plugin-help">Allow plugins and individual tools for <strong>${escapeHtml(modelLabel(file))}</strong>. Global restrictions still apply. Save this model, then apply changes.</p>
      ${catalog.error ? `<p class="error-text">Plugin list unavailable: ${escapeHtml(catalog.error)}. Refresh configuration to retry; saved restrictions are retained.</p>` : ""}
      <div class="model-plugin-list">
        ${plugins.map((plugin, index) => renderPluginRow(file, plugin, catalog.plugins[index], viewState)).join("")}
      </div>
      ${renderSavedRules(file, viewState)}
    </div>
  </details>`;
}
