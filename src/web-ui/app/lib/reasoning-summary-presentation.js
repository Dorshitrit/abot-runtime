const SUMMARY_CHOICES = [["", "Off"], ["auto", "Auto"], ["concise", "Concise"], ["detailed", "Detailed"]];

export function readReasoningSummarySelection(value) {
  if (value === undefined || value === null) return "";
  if (value === "auto" || value === "concise" || value === "detailed") return value;
  return "unsupported";
}

export function renderReasoningSummaryOptions(value) {
  const selected = readReasoningSummarySelection(value);
  const unsupported = selected === "unsupported"
    ? '<option value="unsupported" selected disabled>Unsupported saved value</option>' : "";
  return unsupported + SUMMARY_CHOICES.map(([choice, label]) =>
    `<option value="${choice}" ${selected === choice ? "selected" : ""}>${label}</option>`,
  ).join("");
}

export function reasoningSummaryLabel(value) {
  const selected = readReasoningSummarySelection(value);
  return SUMMARY_CHOICES.find(([choice]) => choice === selected)?.[1] || "Saved value unchanged";
}
