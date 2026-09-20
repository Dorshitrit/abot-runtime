import { escapeAttribute, escapeHtml } from "../../lib/text-format.js";

function pluginMasterIsEnabled(plugin) {
  if (typeof plugin.pluginEnabled === "boolean") return plugin.pluginEnabled;
  return plugin.selectedCapabilityCount > 0;
}

function configuredPluginLabel(plugin) {
  if (!pluginMasterIsEnabled(plugin)) return "Configured off";
  if (plugin.selectedCapabilityCount === 0) return "No tools selected";
  if (plugin.state === "partial") return "Partially selected";
  return "Configured on";
}

function capabilityBlockReason(plugin, capability) {
  if (capability.blockedReason) return capability.blockedReason;
  if (plugin.blockedByGlobalPolicy)
    return "Blocked by the global plugin policy.";
  if (!pluginMasterIsEnabled(plugin))
    return "Enable this plugin before changing individual tools.";
  if (capability.blockedByPolicy)
    return "Blocked by an existing plugin policy rule.";
  return "";
}

function renderCapabilityRow(plugin, capability, busy) {
  const reason = capabilityBlockReason(plugin, capability);
  const blocked = Boolean(reason);
  const reasonId = `plugin-tool-policy-${encodeURIComponent(plugin.id)}-${encodeURIComponent(capability.id)}`;
  const enabled = capability.enabled === true && !blocked;
  return `<li class="plugin-capability-row">
    <div class="plugin-capability-copy"><code>${escapeHtml(capability.id)}</code>
      <p class="plugin-capability-description" title="${escapeAttribute(capability.description || "No description provided.")}">${escapeHtml(capability.description || "No description provided.")}</p>
      ${reason ? `<p class="plugin-capability-policy" id="${escapeAttribute(reasonId)}">${escapeHtml(reason)}</p>` : ""}
    </div>
    <label class="plugin-capability-switch">
      <input type="checkbox" role="switch" data-plugin-capability-toggle="${escapeAttribute(capability.id)}" data-plugin-parent="${escapeAttribute(plugin.id)}"
        aria-label="${escapeAttribute(`${capability.id} in ${plugin.id}`)}" ${reason ? `aria-describedby="${escapeAttribute(reasonId)}"` : ""}
        ${enabled ? "checked" : ""} ${busy || blocked ? "disabled" : ""} />
      <span aria-hidden="true"></span>
    </label>
  </li>`;
}

function renderCapabilities(plugin, busy, open) {
  const capabilities = plugin.capabilities || [];
  const panelId = `plugin-tools-${encodeURIComponent(plugin.id)}`;
  return `<section class="plugin-tools-panel" id="${escapeAttribute(panelId)}" data-plugin-tools-panel="${escapeAttribute(plugin.id)}" aria-label="${escapeAttribute(`Tools in ${plugin.id}`)}" ${open ? "" : "hidden"}>
    <header class="plugin-tools-heading">
      <button type="button" data-plugin-tools-back="${escapeAttribute(plugin.id)}" aria-label="${escapeAttribute(`Back to ${plugin.id}`)}">Back</button>
      <div><h4 title="${escapeAttribute(plugin.id)}">${escapeHtml(plugin.id)}</h4><span>Tools (${capabilities.length})</span></div>
    </header>
    <ul class="plugin-capability-list" data-plugin-tools-scroll="${escapeAttribute(plugin.id)}">
      ${capabilities.length ? capabilities.map((capability) => renderCapabilityRow(plugin, capability, busy)).join("") : '<li class="plugin-capability-empty">This plugin does not expose any tools.</li>'}
    </ul>
  </section>`;
}

function renderPluginCard(plugin, busy, openPluginIds) {
  const toolsOpen = openPluginIds.has(plugin.id);
  const selected = pluginMasterIsEnabled(plugin);
  const disabled = busy || plugin.blockedByGlobalPolicy;
  const action = selected ? "Disable" : "Enable";
  return `
    <article class="plugin-card" data-plugin-id="${escapeAttribute(plugin.id)}">
      <div class="plugin-card-front" data-plugin-card-front="${escapeAttribute(plugin.id)}" ${toolsOpen ? 'inert aria-hidden="true"' : ""}>
      <div class="plugin-card-heading">
        <div>
          <h3 title="${escapeAttribute(plugin.id)}">${escapeHtml(plugin.id)}</h3>
          ${plugin.version ? `<span class="plugin-version">v${escapeHtml(plugin.version)}</span>` : ""}
        </div>
        <span class="plugin-selection-state" data-plugin-state="${escapeAttribute(plugin.state)}">${configuredPluginLabel(plugin)}</span>
      </div>
      <p class="plugin-description" title="${escapeAttribute(plugin.description || "Installed Runtime plugin.")}">${escapeHtml(plugin.description || "Installed Runtime plugin.")}</p>
      <div class="plugin-card-footer">
        <span>${plugin.selectedCapabilityCount} of ${plugin.capabilityCount} capabilities selected</span>
        <button type="button" data-plugin-toggle="${escapeAttribute(plugin.id)}" data-plugin-enabled="${selected ? "false" : "true"}"
          aria-label="${escapeAttribute(`${action} ${plugin.id}`)}" ${disabled ? "disabled" : ""}>${action}</button>
      </div>
      <button type="button" class="plugin-tools-open" data-plugin-tools-open="${escapeAttribute(plugin.id)}" aria-controls="${escapeAttribute(`plugin-tools-${encodeURIComponent(plugin.id)}`)}" aria-expanded="${toolsOpen}" aria-label="${escapeAttribute(`Manage tools in ${plugin.id}`)}">
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h9m4 0h3M4 17h3m4 0h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>
        <span>Manage tools</span>
        <span class="plugin-tools-count" aria-hidden="true">${plugin.capabilityCount}</span>
      </button>
      </div>
      ${renderCapabilities(plugin, busy, toolsOpen)}
    </article>`;
}

function globalPolicyMessage(selection) {
  if (selection?.enabled === false) {
    return "Plugins are disabled globally. Turn on plugins.enabled in Advanced settings before enabling individual plugins.";
  }
  if (selection?.deny?.includes("*")) {
    return "The global deny rule blocks every plugin. Review plugins.deny in Advanced settings before enabling individual plugins.";
  }
  return "";
}

export function renderPluginManager({
  snapshot,
  busy,
  message,
  error,
  openPluginIds = new Set(),
}) {
  const plugins = snapshot?.plugins || [];
  const globalMessage = globalPolicyMessage(snapshot?.selection);
  const status = error || message;
  return `
    <section class="plugin-manager" aria-label="Installed plugins" aria-busy="${busy ? "true" : "false"}">
      <div class="plugin-manager-heading">
        <div>
          <h2>Installed plugins</h2>
          <p>Choose the tools available to your agent. Open Tools to control individual tools within each plugin.</p>
        </div>
        <button type="button" data-plugin-refresh ${busy ? "disabled" : ""}>Refresh plugins</button>
      </div>
      <p class="plugin-application-note">This list shows saved configuration. Apply changes or restart Runtime to use a new selection.</p>
      ${globalMessage ? `<p class="plugin-policy-note">${escapeHtml(globalMessage)}</p>` : ""}
      <div class="plugin-manager-status ${error ? "error-text" : ""}" role="${error ? "alert" : "status"}" aria-live="polite">${escapeHtml(status)}</div>
      ${plugins.length ? `<div class="plugin-grid">${plugins.map((plugin) => renderPluginCard(plugin, busy, openPluginIds)).join("")}</div>` : `<div class="empty-state compact">${busy ? "Loading installed plugins..." : "No installed plugins found."}</div>`}
    </section>`;
}
