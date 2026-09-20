import { parse } from "dotenv";
import { RuntimeSetupError } from "./runtime-setup-input.js";

function canRoundTripEnvironmentAssignment(
  assignment: string,
  key: string,
  value: string,
): boolean {
  if (/[\r\n]/u.test(value)) return false;
  const parsed = parse(assignment);
  if (Object.keys(parsed).length !== 1) return false;
  return parsed[key] === value;
}

function serializeEnvironmentAssignment(key: string, value: string): string {
  // Both startup readers strip these quotes. Single quotes preserve literal \n/\r.
  for (const quote of ['"', "'"]) {
    const assignment = `${key}=${quote}${value}${quote}`;
    if (canRoundTripEnvironmentAssignment(assignment, key, value))
      return assignment;
  }
  throw new RuntimeSetupError(
    "unsupported_setup_environment_value",
    "A setup value cannot be preserved in the local environment file.",
    400,
  );
}

export function replaceRuntimeSetupEnvironmentAssignment(
  raw: string,
  key: string,
  value: string,
): string {
  const assignment = serializeEnvironmentAssignment(key, value);
  const prefix = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`, "u");
  const lines = raw.split(/\r?\n/u).filter((line) => !prefix.test(line));
  while (lines.at(-1) === "") lines.pop();
  return [...lines, assignment, ""].join("\n");
}
