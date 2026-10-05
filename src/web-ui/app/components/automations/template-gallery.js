import { escapeHtml } from "../../lib/text-format.js";
import { toolDisplayName } from "./editor.js";

function isAdvancedTemplate(template) {
  return template.level === "advanced";
}

function templateTextItems(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item.trim());
}

function templateCountLabel(value, singular, plural = `${singular}s`) {
  if (!Number.isInteger(value) || value < 0) return "";
  return `${value} ${value === 1 ? singular : plural}`;
}

function renderTemplateFacts(template) {
  const counts = [templateCountLabel(template.stepCount, "step"),
    templateCountLabel(template.agentCount, "agent")];
  if (template.parallelGroupCount > 0) {
    counts.push(templateCountLabel(template.parallelGroupCount, "parallel group"));
  }
  return counts.filter(Boolean).map((label) => `<span>${escapeHtml(label)}</span>`).join("");
}

function renderTemplateDetails(label, items, className) {
  if (!items.length) return "";
  return `<span class="automation-template-detail ${className}">
    <span class="automation-template-detail-label">${label}</span>
    ${items.map((item) => `<span class="automation-template-detail-item">${escapeHtml(item)}</span>`).join("")}
  </span>`;
}

function renderTemplateCard(template) {
  return `<button type="button" class="automation-template-card${isAdvancedTemplate(template) ? " automation-template-card-advanced" : ""}" data-template-id="${escapeHtml(template.id)}" aria-label="Use ${escapeHtml(template.title)} template">
    <span class="automation-template-meta">${escapeHtml(template.category)}</span>
    <strong>${escapeHtml(template.title)}</strong>
    <span class="automation-template-description">${escapeHtml(template.description)}</span>
    <span class="automation-template-facts">${renderTemplateFacts(template)}</span>
    ${renderTemplateDetails("What you'll explore", templateTextItems(template.highlights), "automation-template-learning")}
    ${renderTemplateDetails("Saved outputs", templateTextItems(template.outputFiles), "automation-template-outputs")}
    ${template.setup ? `<span class="automation-template-setup"><span class="automation-template-detail-label">Before running</span>${escapeHtml(template.setup)}</span>` : ""}
    <span class="automation-template-tools">${templateTextItems(template.toolNames).map((name) => escapeHtml(toolDisplayName(name))).join(" · ")}</span>
    <span class="automation-template-action">Use template <span aria-hidden="true">→</span></span>
  </button>`;
}

function renderTemplateSection(templates, level, title, description) {
  if (!templates.length) return "";
  return `<section class="automation-template-section" aria-labelledby="automation-templates-${level}-title">
    <div class="automation-template-section-heading"><h5 id="automation-templates-${level}-title">${title}</h5><p>${description}</p></div>
    <div class="automation-template-grid automation-template-grid-${level}">${templates.map(renderTemplateCard).join("")}</div>
  </section>`;
}

export function renderAutomationTemplateGallery(snapshot) {
  const templates = Array.isArray(snapshot.templateCatalog?.templates)
    ? snapshot.templateCatalog.templates : [];
  const advanced = templates.filter(isAdvancedTemplate);
  const starters = templates.filter((template) => !isAdvancedTemplate(template));
  const emptyMessage = snapshot.templateCatalogError || (!snapshot.templateCatalog
    ? "Finding templates for your available tools…"
    : "No templates match the tools currently available in this environment.");
  return `<section class="automation-templates" aria-labelledby="automation-templates-title">
    <div class="automation-template-heading"><div><span class="automation-kicker">BUILD AND LEARN</span>
      <h4 id="automation-templates-title">Start from a template</h4>
      <p>Only templates supported by your current tools appear here. Each opens an editable draft; review its inputs, model, and permissions before publishing.</p></div>
      ${templates.length ? `<span class="automation-template-count">${templates.length} available</span>` : ""}</div>
    ${renderTemplateSection(advanced, "advanced", "Explore complete workflows", "Follow multiple agents, parallel branches, and saved results through a complete workflow.")}
    ${renderTemplateSection(starters, "starter", "Start small", "Learn one pattern at a time, then adapt it to your own automation.")}
    ${templates.length ? "" : `<p class="automation-template-empty">${escapeHtml(emptyMessage)}</p>`}
  </section>`;
}
