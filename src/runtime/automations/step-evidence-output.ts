const OUTPUT_PREVIEW_CHARACTERS = 4_000;

export type AutomationOutputPart = Readonly<{
  value: string;
  truncated: boolean;
  totalCharacters: number;
}>;

export type AutomationSavedOutput = Readonly<{
  text?: AutomationOutputPart;
  data?: AutomationOutputPart;
  full: boolean;
}>;

export type AutomationSavedOutcome = Readonly<{
  kind: "rejected" | "uncertain";
  errorCode?: string;
}>;

function projectPart(value: string, full: boolean): AutomationOutputPart {
  return {
    value: full ? value : value.slice(0, OUTPUT_PREVIEW_CHARACTERS),
    truncated: !full && value.length > OUTPUT_PREVIEW_CHARACTERS,
    totalCharacters: value.length,
  };
}

/** Direct-tool rejections and uncertain results intentionally have no output text. */
export function projectAutomationSavedOutput(value: unknown, full: boolean): AutomationSavedOutput | null {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("automation_result_invalid");
  const saved = value as { text?: unknown; data?: unknown };
  if (saved.text === undefined && saved.data === undefined) return null;
  if (saved.text !== undefined && typeof saved.text !== "string")
    throw new Error("automation_result_invalid");
  let structured: string | undefined;
  if (saved.data !== undefined) {
    try { structured = JSON.stringify(saved.data, null, 2); } catch {
      throw new Error("automation_result_invalid");
    }
    if (typeof structured !== "string") throw new Error("automation_result_invalid");
  }
  return {
    ...(typeof saved.text === "string" ? { text: projectPart(saved.text, full) } : {}),
    ...(structured !== undefined ? { data: projectPart(structured, full) } : {}),
    full,
  };
}

export function projectAutomationSavedOutcome(value: unknown): AutomationSavedOutcome | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const saved = value as { kind?: unknown; code?: unknown };
  if (saved.kind !== "rejected" && saved.kind !== "uncertain") return undefined;
  return { kind: saved.kind,
    ...(typeof saved.code === "string" ? { errorCode: saved.code } : {}) };
}
