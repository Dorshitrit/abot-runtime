const COMPUTER_ACTIONS = new Set([
  "click",
  "move",
  "drag",
  "scroll",
  "type_text",
  "press_keys",
  "focus_window",
]);

function hasRecordedComputerAction(meta) {
  return COMPUTER_ACTIONS.has(meta.computerAction);
}

function isTypedTextAction(meta) {
  return meta.computerAction === "type_text";
}

function textField(fields, label, value, limit = 128) {
  if (typeof value !== "string" || value.length === 0) return;
  fields.push({ label, value: value.slice(0, limit) });
}

function numberField(fields, label, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  fields.push({ label, value: String(value) });
}

function hasCompleteTypedText(meta, text) {
  if (meta.computerTextLength === 0) return text === "";
  if (meta.computerTextTruncated !== false) return false;
  if (text.length > 4_096) return false;
  return text.length === meta.computerTextLength;
}

function hasCompleteKeyChord(meta) {
  if (!Array.isArray(meta.computerKeys)) return false;
  if (meta.computerKeys.length > 8) return false;
  if (meta.computerKeysTruncated !== false) return false;
  return meta.computerKeys.every(
    (key) => typeof key === "string" && key.length <= 32,
  );
}

/** Inert plugin-declared display evidence; never infer controls from intent. */
export function computerInputFields(meta) {
  if (!hasRecordedComputerAction(meta)) return [];
  const fields = [{ label: "Action", value: meta.computerAction }];
  textField(fields, "Observation reference", meta.computerObservation);
  textField(fields, "Window reference", meta.computerWindow);
  numberField(fields, "Image X", meta.computerX);
  numberField(fields, "Image Y", meta.computerY);
  numberField(fields, "From image X", meta.computerFromX);
  numberField(fields, "From image Y", meta.computerFromY);
  numberField(fields, "To image X", meta.computerToX);
  numberField(fields, "To image Y", meta.computerToY);
  textField(fields, "Button", meta.computerButton);
  numberField(fields, "Click count", meta.computerClickCount);
  numberField(fields, "Duration (ms)", meta.computerDurationMs);
  numberField(fields, "Horizontal scroll", meta.computerDeltaX);
  numberField(fields, "Vertical scroll", meta.computerDeltaY);
  if (isTypedTextAction(meta)) {
    const text = typeof meta.computerText === "string" ? meta.computerText : "";
    const label = hasCompleteTypedText(meta, text)
      ? "Typed text"
      : "Typed text excerpt";
    fields.push({ label, value: text.slice(0, 4_096) });
    numberField(fields, "Text characters", meta.computerTextLength);
  }
  if (hasCompleteKeyChord(meta)) {
    fields.push({ label: "Keys", value: JSON.stringify(meta.computerKeys) });
  }
  return fields;
}
