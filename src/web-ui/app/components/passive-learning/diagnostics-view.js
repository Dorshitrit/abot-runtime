import { learningFailureCopy } from "./failure-copy.js";

/** Render status codes with explanations, without interpreting provider error bodies. */
export function renderLearningDiagnostics(container, reasons) {
  container.replaceChildren();
  const documentRoot = container.ownerDocument;
  for (const reason of new Set(reasons.filter(Boolean))) {
    const copy = learningFailureCopy(reason);
    const code = diagnosticCode(reason);
    const row = documentRoot.createElement("div");
    row.className = "passive-learning-diagnostic-row";
    const key = documentRoot.createElement("dt");
    const label = documentRoot.createElement("code");
    label.textContent = code;
    key.append(label);
    const description = documentRoot.createElement("dd");
    description.textContent = copy.code ? copy.message : "No explanation is available for this status yet.";
    row.append(key);
    row.append(description);
    container.append(row);
  }
}

function diagnosticCode(value) {
  if (typeof value !== "string") return "unrecognized_status";
  if (!/^[a-z][a-z0-9_]{0,100}$/u.test(value)) return "unrecognized_status";
  return value;
}
