export function automationRerunConfirmation(run) {
  const revision = run?.definitionRevision ?? run?.target?.definitionRevision ?? run?.definition?.revision;
  const inputVersions = Array.isArray(run?.report?.inputVersions) ? run.report.inputVersions : [];
  const versionLines = inputVersions.map((input) =>
    `• ${input.canonicalPath || input.inputId || "Input"} — ${input.contentVersion || "version unavailable"}`);
  return [
    `Start another run from published definition revision ${revision ?? "unavailable"}?`,
    "",
    versionLines.length
      ? `The previous run selected these ${inputVersions.length} input version${inputVersions.length === 1 ? "" : "s"}:`
      : "No selected input versions were recorded for the previous run.",
    ...versionLines,
    "",
    "Earlier successful external actions may happen again. Current permissions and run limits still apply.",
  ].join("\n");
}
