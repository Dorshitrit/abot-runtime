import { escapeAttribute, escapeHtml } from "../../lib/text-format.js";

export function isPluginPlatformUnavailable(compatibility) {
  return compatibility?.supported === false;
}

export function renderPluginPlatformNotice(compatibility) {
  if (!isPluginPlatformUnavailable(compatibility)) return "";
  const platform = compatibility.runtimePlatform || "this host";
  const reason =
    compatibility.reason || "This plugin cannot load on this host.";
  return `<p class="plugin-capability-policy plugin-platform-notice" data-plugin-platform="${escapeAttribute(platform)}"><strong>Unavailable on this host.</strong> ${escapeHtml(reason)}</p>`;
}
