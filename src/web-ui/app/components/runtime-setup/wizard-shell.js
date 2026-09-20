import { escapeAttribute, escapeHtml } from "../../lib/text-format.js";

export function renderWizardProgress(steps, step) {
  return `<ol class="runtime-setup-progress" aria-label="Setup progress" style="grid-template-columns:repeat(${steps.length},minmax(0,1fr))">${steps.map((label, index) => `<li ${index === step ? 'aria-current="step"' : ""} class="${index < step ? "complete" : ""}"><span aria-hidden="true">${index + 1}</span><span class="runtime-setup-progress-label">${escapeHtml(label)}</span></li>`).join("")}</ol>`;
}

export function renderWizardShell({
  steps,
  step,
  title,
  description = "",
  content,
  footer,
  busy = false,
  panelClass = "",
  form = true,
  idPrefix = "runtimeSetup",
}) {
  const tag = form ? "form" : "section";
  return `<${tag} class="runtime-setup-panel${panelClass ? ` ${escapeAttribute(panelClass)}` : ""}" ${form ? "novalidate" : ""} aria-busy="${Boolean(busy)}" aria-labelledby="${escapeAttribute(idPrefix)}Title">
    <div data-wizard-progress>${renderWizardProgress(steps, step)}</div>
    <p class="runtime-setup-mobile-progress" data-wizard-mobile-progress aria-hidden="true">Step ${step + 1} of ${steps.length} · ${escapeHtml(steps[step])}</p>
    <header class="runtime-setup-heading"><h3 tabindex="-1" id="${escapeAttribute(idPrefix)}Title" data-runtime-setup-title>${escapeHtml(title)}</h3><p data-wizard-description ${description ? "" : "hidden"}>${escapeHtml(description)}</p></header>
    <div class="runtime-setup-content" data-wizard-content ${busy ? "inert" : ""}>${content}</div>
    <footer class="runtime-setup-footer" data-wizard-footer>${footer}</footer>
  </${tag}>`;
}
