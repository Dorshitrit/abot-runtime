/** A portable basename; the runtime owns the per-run directory, never the model. */
export function isAutomationRunFileName(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 120) return false;
  if (value !== value.trim() || value.endsWith(".")) return false;
  if (value === "." || value === "..") return false;
  if (/[<>:"/\\|?*\u0000-\u001f]/u.test(value)) return false;
  return !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(value);
}

export function automationRunFilePath(runId: string | undefined, fileName: string): string | null {
  if (!runId || !/^[A-Za-z0-9_-]{1,128}$/u.test(runId)) return null;
  if (!isAutomationRunFileName(fileName)) return null;
  return `automation-output/${runId}/${fileName}`;
}
