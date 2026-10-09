import { escapeHtml } from "../../lib/text-format.js";

export function renderRetainedPluginSecrets(secrets = []) {
  if (!secrets.length) return "";
  return `<section class="plugin-retained-secrets">
    <h3>Keys no longer used by this plugin</h3>
    <p>These saved keys stay on this device until you choose to delete them. Delete an old key before configuring a new key with the same name.</p>
    ${secrets.map((secret, index) => `<label class="plugin-setting-checkbox"><input type="checkbox" data-plugin-retained-secret="${index}"><span>Delete saved key <strong>${escapeHtml(secret.name)}</strong> <small>${escapeHtml(secret.env)}</small></span></label>`).join("")}
  </section>`;
}

export function readRetainedPluginSecretClears(root, secrets = []) {
  return secrets.flatMap((secret, index) => {
    const input = root?.querySelector(
      `[data-plugin-retained-secret="${index}"]`,
    );
    if (!input?.checked) return [];
    return [{ name: secret.name, env: secret.env }];
  });
}
