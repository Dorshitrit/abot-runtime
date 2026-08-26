import type { ToolCallAdapter } from "../../../src/plugin-sdk/index.js";

function invalidStrings(
  params: Readonly<Record<string, unknown>>,
  names: readonly string[],
): string[] {
  return names.filter((name) => {
    const value = params[name];
    return typeof value !== "string" || value.trim().length === 0;
  });
}

export const editFileAdapter: ToolCallAdapter = Object.freeze({
  validateCall(input) {
    const invalid = invalidStrings(input.params, ["path", "instruction"]);
    return invalid.length
      ? {
          error: `invalid params for edit_file: ${invalid.join(", ")}`,
          repairHint:
            "Provide one existing path and one concise change instruction. The runtime materializes selection and content separately.",
        }
      : null;
  },
});

export const writeFileAdapter: ToolCallAdapter = Object.freeze({
  validateCall(input) {
    const target = input.params.path;
    if (typeof target !== "string" || target.trim().length === 0) {
      return {
        error: "invalid path for write_file",
        repairHint: "Set path to exactly one non-empty logical target path.",
      };
    }
    if (target.split("|").filter((part) => part.trim()).length > 1) {
      return {
        error: "single_target_path_required",
        repairHint:
          "Set path to exactly one target. Invoke write_file separately for each file.",
      };
    }
    return null;
  },
});
