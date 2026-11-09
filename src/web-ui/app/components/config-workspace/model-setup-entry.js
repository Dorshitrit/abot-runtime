import { escapeAttribute, escapeHtml } from "../../lib/text-format.js";
import { configuredProviderConnections, providerEditFields } from "./provider-connections.js";

export function renderModelSetupEntry(runtime, models) {
  const cards = configuredProviderConnections(runtime, models)
    .map((connection) => {
      const { id, type: providerType, modelIds, embeddingIds } = connection;
      const count = modelIds.length;
      const providerId = escapeAttribute(id);
      const hasDistinctProviderType =
        providerType.length > 0 &&
        providerType.toLowerCase() !== id.toLowerCase();
      return `<article class="config-provider-card">
        <div class="config-provider-identity"><h3>${escapeHtml(id)}</h3>${hasDistinctProviderType ? `<span>${escapeHtml(providerType)}</span>` : ""}</div>
        <div class="config-provider-usage"><span>${count} ${count === 1 ? "model" : "models"}</span>${embeddingIds.length ? `<span> · ${embeddingIds.length} embedding ${embeddingIds.length === 1 ? "profile" : "profiles"}</span>` : ""}</div>
        <footer>
          ${providerEditFields(providerType).length ? `<button type="button" data-config-action="edit-provider" data-provider-id="${providerId}" aria-label="Edit ${providerId} connection">Edit</button>` : ""}
          <button type="button" data-config-action="delete-provider" data-provider-id="${providerId}" aria-label="Delete ${providerId} connection">Delete</button>
          ${providerType === "openai-chatgpt" ? `<button type="button" data-config-action="chatgpt-accounts" data-account-ref="${escapeAttribute(connection.settings.accountRef)}">ChatGPT account</button>` : ""}
        </footer>
      </article>`;
    })
    .join("");
  return `<div class="config-model-setup-entry">
    <header><div><h2>Models and providers</h2><p>Add a model using a saved connection or connect a new provider.</p></div>
      <div class="chatgpt-account-actions"><button type="button" data-config-action="chatgpt-accounts">ChatGPT accounts</button><button type="button" data-config-action="add-model">Add model</button></div>
    </header>
    ${cards ? `<div class="config-provider-grid" aria-label="Configured providers">${cards}</div>` : ""}
  </div>`;
}
