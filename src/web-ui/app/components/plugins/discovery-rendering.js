import { renderPluginConfigurationFields } from "./configuration-fields.js";
import { escapeAttribute, escapeHtml } from "../../lib/text-format.js";

function renderPluginReview(review, busy) {
  if (!review) return "";
  const installButton = `<button type="button" class="primary-button" data-plugin-install-confirm ${busy ? "disabled" : ""}>${busy ? "Installing…" : "Install and enable"}</button>`;
  return `<section class="plugin-install-review" aria-label="Plugin installation review">
    <header class="plugin-install-heading"><div><h3>${escapeHtml(review.id)} ${review.version ? `<small>v${escapeHtml(review.version)}</small>` : ""}</h3><p>Not installed yet.</p></div>${installButton}</header>
    <p>${escapeHtml(review.description)}</p>
    <dl><dt>Source</dt><dd>${escapeHtml(review.source.repository)}</dd><dt>Commit</dt><dd><code>${escapeHtml(review.source.ref)}</code></dd></dl>
    <ul class="plugin-install-capabilities">${review.capabilities.map((capability) => `<li><strong>${escapeHtml(capability.id)}</strong><p>${escapeHtml(capability.description)}</p><span>${capability.operations.map((operation) => escapeHtml(`${operation.name} · ${operation.effect}`)).join(" / ")}</span></li>`).join("")}</ul>
    ${renderPluginConfigurationFields(review.configuration, busy)}
    <p class="plugin-install-trust">This plugin contains code that runs with the Runtime's access. Install it only if you trust its publisher. Installation does not run a build or setup script.</p>
    ${installButton}
    <button type="button" data-plugin-review-cancel ${busy ? "disabled" : ""}>Cancel review</button>
  </section>`;
}

export function renderPluginDiscovery(state) {
  return `<section class="plugin-discovery" aria-label="Discover plugins" aria-busy="${state.busy}">
    <article class="plugin-marketplace-card"><h2>More tools. More possibilities.</h2>
      <p>Discover plugins shared by the community and extend what your agent can do.</p>
      <a href="https://abot-ai.com/marketplace/" target="_blank" rel="noopener noreferrer">Browse Marketplace ↗</a>
    </article>
    <section class="plugin-source-card"><h2>Install from GitHub</h2>
      <p>Paste a public repository link. With Computer Access, an Install in ABot link opens this review directly.</p>
      <form data-plugin-source-form>
        <label><span>Repository URL</span><input name="repository" type="url" autocomplete="off" placeholder="https://github.com/owner/plugin" value="${escapeAttribute(state.source.repository)}" required ${state.busy ? "disabled" : ""}></label>
        <div class="plugin-source-options"><label><span>Revision <small>(optional)</small></span><input name="ref" autocomplete="off" placeholder="Branch, tag or commit" value="${escapeAttribute(state.source.ref || "")}" ${state.busy ? "disabled" : ""}></label>
        <label><span>Plugin folder <small>(optional)</small></span><input name="path" autocomplete="off" placeholder="Repository root" value="${escapeAttribute(state.source.path || "")}" ${state.busy ? "disabled" : ""}></label></div>
        <button type="submit" ${state.busy ? "disabled" : ""}>${state.busy ? "Working…" : "Review plugin"}</button>
      </form>
      <p data-plugin-install-status class="${state.error ? "error-text" : ""}" role="${state.error ? "alert" : "status"}" aria-live="polite">${escapeHtml(state.error || state.message)}</p>
      ${renderPluginReview(state.review, state.busy)}
    </section>
  </section>`;
}
