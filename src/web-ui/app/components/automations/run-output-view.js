import { escapeHtml, renderMarkdown } from "../../lib/text-format.js";

const MAX_PREVIEW_DEPTH = 6;
const MAX_PREVIEW_VALUES = 80;

function parseCompleteJson(part) {
  if (!part || part.truncated || typeof part.value !== "string") return { parsed: false };
  try { return { parsed: true, value: JSON.parse(part.value) }; }
  catch { return { parsed: false }; }
}

function hasDuplicateJsonText(output, structured) {
  if (!output.text || !output.data) return false;
  const text = parseCompleteJson(output.text);
  if (!text.parsed || !structured.parsed) return false;
  try { return JSON.stringify(text.value) === JSON.stringify(structured.value); }
  catch { return false; }
}

function keyLabel(key) {
  return key.replaceAll("_", " ").replaceAll("-", " ").replace(/^./u, (first) => first.toUpperCase());
}

function renderString(value) {
  if (value === "") return `<span class="automation-output-empty">Empty text</span>`;
  return `<div class="markdown-body automation-output-prose" dir="auto">${renderMarkdown(value)}</div>`;
}

function renderStructured(value, context, depth = 0) {
  const previewBudgetExhausted = depth > MAX_PREVIEW_DEPTH || context.remaining <= 0;
  if (previewBudgetExhausted) {
    context.omitted = true;
    return `<span class="automation-output-empty">More in raw output</span>`;
  }
  context.remaining -= 1;
  if (value === null) return `<span class="automation-output-value" data-value-type="null">null</span>`;
  if (typeof value === "string") return renderString(value);
  if (typeof value !== "object")
    return `<span class="automation-output-value" data-value-type="${typeof value}">${escapeHtml(String(value))}</span>`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `<span class="automation-output-empty">Empty list</span>`;
    const visible = value.slice(0, context.remaining);
    if (visible.length < value.length) context.omitted = true;
    return `<ol class="automation-output-list">${visible.map((item) =>
      `<li>${renderStructured(item, context, depth + 1)}</li>`).join("")}</ol>`;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return `<span class="automation-output-empty">Empty object</span>`;
  const visible = entries.slice(0, context.remaining);
  if (visible.length < entries.length) context.omitted = true;
  return `<dl class="automation-output-fields">${visible.map(([key, item]) =>
    `<div><dt dir="auto">${escapeHtml(keyLabel(key))}</dt><dd>${renderStructured(item, context, depth + 1)}</dd></div>`).join("")}</dl>`;
}

function previewNotice(part) {
  if (!part?.truncated) return "";
  return `<p class="automation-output-notice">Preview: ${escapeHtml(part.value.length)} of ${escapeHtml(part.totalCharacters)} characters.</p>`;
}

function renderPart(part, parsed, label) {
  if (!part) return "";
  const context = { remaining: MAX_PREVIEW_VALUES, omitted: false };
  const content = parsed.parsed ? renderStructured(parsed.value, context) : renderString(part.value);
  return `<section class="automation-output-part" aria-label="${label}">${content}${previewNotice(part)}
    ${context.omitted ? `<p class="automation-output-notice">Some nested values are omitted from this readable view. The raw output contains all loaded values.</p>` : ""}</section>`;
}

function rawPart(label, part) {
  if (!part) return "";
  return `<h6>${label}</h6><pre dir="auto">${escapeHtml(part.value)}</pre>${previewNotice(part)}`;
}

function renderDataPreview(data, parsed, hasPrimaryText, disclosureId) {
  if (!data) return "";
  const content = data.truncated
    ? `<p class="automation-output-notice">The structured result is incomplete in this preview. Open Raw saved output to inspect the loaded data.</p>${previewNotice(data)}`
    : renderPart(data, parsed, "Saved structured data");
  if (!hasPrimaryText) return content;
  return `<details class="automation-output-source" data-disclosure-id="${escapeHtml(disclosureId)}-data"><summary>Additional structured data</summary>${content}</details>`;
}

export function hasTruncatedAutomationOutput(output) {
  return Boolean(output?.text?.truncated || output?.data?.truncated);
}

/** Saved values are presented generically; their field names never determine run status. */
export function renderAutomationSavedOutput(output, { disclosureId = "output", showFullButton = false } = {}) {
  if (!output) return "";
  const structured = parseCompleteJson(output.data);
  const duplicateText = hasDuplicateJsonText(output, structured);
  const text = duplicateText ? null : output.text;
  const textJson = parseCompleteJson(text);
  const dataPreview = renderDataPreview(output.data, structured, Boolean(text), disclosureId);
  return `<div class="automation-saved-output">
    ${renderPart(text, textJson, "Saved text")}${dataPreview}
    ${showFullButton && hasTruncatedAutomationOutput(output) ? `<button type="button" class="automation-output-more" data-action="show-full-step-output">Show full saved output</button>` : ""}
    <details class="automation-output-source" data-disclosure-id="${escapeHtml(disclosureId)}"><summary>Raw saved output</summary>
      ${rawPart("Saved text", text)}${rawPart("Saved structured data", output.data)}</details>
  </div>`;
}
