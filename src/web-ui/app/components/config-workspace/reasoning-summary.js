import { escapeAttribute } from "../../lib/text-format.js";
import { renderReasoningSummaryOptions } from "../../lib/reasoning-summary-presentation.js";

function canConfigureReasoningSummary(file, dashboard) {
  if (file.kind !== "model") return false;
  const provider = file.config?.provider;
  return dashboard?.files?.runtime?.config?.models?.providers?.[provider]?.type === "openai";
}

export function parseReasoningSummaryInput(value) {
  return value === "" ? null : value;
}

export function renderModelReasoningSummary(file, dashboard) {
  if (!canConfigureReasoningSummary(file, dashboard)) return "";
  const choices = renderReasoningSummaryOptions(file.config?.options?.reasoningSummary);
  return `<div class="config-model-parameter" role="group" aria-label="Reasoning summary">
    <div class="config-model-parameter-header">
      <span class="config-model-parameter-name">Reasoning summary</span>
      <details class="config-model-parameter-info">
        <summary aria-label="About Reasoning summary">i</summary>
        <div class="config-model-parameter-help"><p>Show summaries of the model's reasoning while it responds. Auto uses the most detailed summary the model supports. Available on supported OpenAI API models; no summary is requested while reasoning is Off.</p></div>
      </details>
    </div>
    <label><span class="sr-only">Reasoning summary</span>
      <select data-config-action="field" data-kind="model" data-id="${escapeAttribute(file.id)}"
        data-path="${escapeAttribute(JSON.stringify(["options", "reasoningSummary"]))}"
        data-value-type="reasoning-summary">${choices}</select>
    </label>
  </div>`;
}
