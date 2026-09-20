import { titleCaseEventValue } from "./event-presentation.js";

const INPUT_TEXT_LIMIT = 4_096;

function textField(fields, label, value, limit = 500) {
  if (typeof value !== "string" || value.length === 0) return;
  const text = value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
  fields.push({ label, value: text });
}

function numberField(fields, label, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  fields.push({ label, value: String(value) });
}

function booleanField(fields, label, value) {
  if (typeof value !== "boolean") return;
  fields.push({ label, value: value ? "Yes" : "No" });
}

function hasCompleteCommandText(meta) {
  if (meta.commandTruncated !== false) return false;
  return (
    typeof meta.command === "string" && meta.command.length <= INPUT_TEXT_LIMIT
  );
}

function hasUnrecordedCommandInput(meta) {
  if (typeof meta.command === "string") return false;
  if (!meta.params || typeof meta.params !== "object") return false;
  return Object.hasOwn(meta.params, "command");
}

/** These are declared event fields, independent of any concrete tool identity. */
export function processInputFields(meta) {
  const fields = [];
  textField(fields, "Computer", meta.computerName);
  textField(fields, "Computer ID", meta.hostId);
  textField(
    fields,
    hasCompleteCommandText(meta) ? "Command" : "Command excerpt",
    meta.command,
    INPUT_TEXT_LIMIT,
  );
  if (hasUnrecordedCommandInput(meta)) {
    fields.push({
      label: "Command details",
      value: "Not recorded in this event",
    });
  }
  textField(fields, "Working directory", meta.cwd, INPUT_TEXT_LIMIT);
  textField(fields, "Process ID", meta.processId);
  numberField(fields, "Cursor", meta.cursor);
  textField(fields, "Application ID", meta.applicationId, INPUT_TEXT_LIMIT);
  if (Array.isArray(meta.arguments)) {
    const argumentsText = meta.arguments
      .slice(0, 32)
      .filter((value) => typeof value === "string");
    const encodedArguments = JSON.stringify(argumentsText);
    textField(
      fields,
      hasCompleteArguments(meta, encodedArguments)
        ? "Arguments"
        : "Arguments excerpt",
      encodedArguments,
      INPUT_TEXT_LIMIT,
    );
    numberField(fields, "Omitted arguments", meta.argumentsOmittedCount);
  }
  numberField(fields, "Timeout (ms)", meta.timeoutMs);
  booleanField(fields, "Elevated", meta.elevated);
  return fields;
}

export function processResultFields(meta) {
  const fields = [];
  numberField(fields, "Exit code", meta.exitCode);
  textField(fields, "Transport", titleCaseEventValue(meta.transport));
  textField(fields, "Process status", titleCaseEventValue(meta.processStatus));
  textField(fields, "Evidence scope", titleCaseEventValue(meta.evidenceScope));
  textField(
    fields,
    "Independent outcome check",
    titleCaseEventValue(meta.independentOutcomeCheck),
  );
  textField(
    fields,
    "Availability scope",
    titleCaseEventValue(meta.availabilityScope),
  );
  numberField(fields, "Catalog matches", meta.observedMatches);
  numberField(fields, "Omitted matches", meta.omittedMatches);
  booleanField(fields, "Declared catalog complete", meta.catalogComplete);
  booleanField(fields, "Absence established", meta.absenceConclusionSupported);
  return fields;
}

function hasCompleteArguments(meta, encodedArguments) {
  if (meta.argumentsTruncated !== false) return false;
  if (meta.arguments.length > 32) return false;
  return encodedArguments.length <= INPUT_TEXT_LIMIT;
}
