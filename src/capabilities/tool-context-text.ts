/** Exact tool text whose model admission belongs to the runtime context gate. */
export type ToolContextTextField = "output" | "stdout" | "stderr";

type ContextTextCarrier = Readonly<{
  contextTextFields?: unknown;
  output?: unknown;
  stdout?: unknown;
  stderr?: unknown;
}>;

/** The declaration changes byte accounting only, never evidence or authority. */
export function hasValidToolContextText(carrier: ContextTextCarrier): boolean {
  const fields = carrier.contextTextFields;
  if (fields === undefined) return true;
  if (!Array.isArray(fields) || fields.length === 0 || fields.length > 3)
    return false;
  if (new Set(fields).size !== fields.length) return false;
  for (const field of fields) {
    if (!isContextTextField(field)) return false;
    if (typeof carrier[field] !== "string") return false;
  }
  return true;
}

function isContextTextField(value: unknown): value is ToolContextTextField {
  return value === "output" || value === "stdout" || value === "stderr";
}

/**
 * Counts only JSON-encoded text content. Property names and string delimiters
 * remain charged to the envelope. No original text is removed or rewritten.
 */
export function measureToolContextTextBytes(carrier: ContextTextCarrier): number {
  if (!hasValidToolContextText(carrier))
    throw new TypeError("tool_context_text_invalid");
  const fields = carrier.contextTextFields as
    | readonly ToolContextTextField[]
    | undefined;
  return (fields ?? []).reduce(
    (total, field) =>
      total + Buffer.byteLength(JSON.stringify(carrier[field]), "utf8") - 2,
    0,
  );
}
