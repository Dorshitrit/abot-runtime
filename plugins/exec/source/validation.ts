import {
  readRequiredString,
  type ToolCallAdapter,
} from "../../../src/plugin-sdk/index.js";
import { ExecPluginError } from "./errors.js";
import { EXEC_COMMAND_MAX_CHARS } from "./settings.js";

function isExecutableCommand(value: string): boolean {
  if (value.trim().length === 0) return false;
  return !value.includes("\0");
}

export function readExecCommand(value: unknown): string {
  const command = readRequiredString(value, {
    name: "command",
    trim: false,
    maxLength: EXEC_COMMAND_MAX_CHARS,
  });
  if (!isExecutableCommand(command)) {
    throw new ExecPluginError(
      "exec_command_invalid",
      "The command must contain nonempty text without NUL characters.",
    );
  }
  return command;
}

function isInvalidExecParameter(name: string, value: unknown): boolean {
  if (typeof value !== "string") return true;
  if (value.length === 0) return true;
  if (name === "command") return !isExecutableCommand(value);
  return value.includes("\0");
}

export function createExecAdapter(): ToolCallAdapter {
  return {
    validateCall(input) {
      const invalid = ["command", "cwd"].filter((name) =>
        isInvalidExecParameter(name, input.params[name]),
      );
      if (invalid.length === 0) return null;
      return {
        error: `invalid params for exec: invalid ${invalid.join(", ")}`,
        repairHint:
          "Provide one command without NUL characters and one explicit existing cwd.",
      };
    },
  };
}
