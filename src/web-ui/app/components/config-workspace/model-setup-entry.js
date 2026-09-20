import { escapeAttribute, escapeHtml } from "../../lib/text-format.js";
import { isConfigObject } from "./config-model.js";

export function renderModelSetupEntry(runtime, models) {
  const config = runtime?.config?.models?.providers;
  const providers = isConfigObject(config) ? Object.entries(config) : [];
  const cards = providers
    .filter(([, provider]) => isConfigObject(provider))
    .map(([id, provider]) => {
      const count = models.filter(
        (model) => model.config?.provider === id,
      ).length;
      return `<article class="config-provider-card">
        <div><h3>${escapeHtml(id)}</h3><span>${escapeHtml(provider.type || "Provider")}</span></div>
        <footer><span>${count} ${count === 1 ? "model" : "models"}</span>
          <button type="button" data-config-action="add-model" data-provider-id="${escapeAttribute(id)}" aria-label="${escapeAttribute(`Add model to ${id}`)}">Add model</button>
        </footer>
      </article>`;
    })
    .join("");
  return `<div class="config-model-setup-entry">
    <header><div><h2>Models and providers</h2><p>Add a model using a saved connection or connect a new provider.</p></div>
      <button type="button" data-config-action="add-model">Add model</button>
    </header>
    ${cards ? `<div class="config-provider-grid" aria-label="Configured providers">${cards}</div>` : ""}
  </div>`;
}
