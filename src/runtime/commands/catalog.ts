import type {
  RuntimeCommandDefinition,
  RuntimeCommandInvocation,
} from "./contracts.js";

export const RUNTIME_COMMANDS: readonly RuntimeCommandDefinition[] =
  Object.freeze([
    Object.freeze({
      name: "compact",
      description: "Compact saved conversation history between runs.",
      modes: Object.freeze(["run"] as const),
      arguments: Object.freeze({
        type: "object" as const,
        additionalProperties: false as const,
      }),
    }),
  ]);

export class RuntimeCommandInputError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function parseRuntimeCommand(
  value: unknown,
  definitions: readonly RuntimeCommandDefinition[] = RUNTIME_COMMANDS,
): RuntimeCommandInvocation {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RuntimeCommandInputError("invalid_command");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) => !["name", "mode", "arguments", "targetRequestId"].includes(key),
    )
  )
    throw new RuntimeCommandInputError("invalid_command");
  const definition = definitions.find(({ name }) => name === input.name);
  if (!definition) throw new RuntimeCommandInputError("unknown_command");
  if (input.mode !== "run" && input.mode !== "steer")
    throw new RuntimeCommandInputError("invalid_command_mode");
  if (!definition.modes.includes(input.mode))
    throw new RuntimeCommandInputError("command_mode_not_supported");
  if (
    input.arguments !== undefined &&
    !hasEmptyCommandArguments(input.arguments)
  )
    throw new RuntimeCommandInputError("invalid_command_arguments");
  if (input.mode === "steer")
    return parseSteeringCommand(definition.name, input.targetRequestId);
  if (input.targetRequestId !== undefined)
    throw new RuntimeCommandInputError("unexpected_command_target");
  return Object.freeze({ name: definition.name, mode: "run" });
}

function parseSteeringCommand(
  name: string,
  targetRequestId: unknown,
): RuntimeCommandInvocation {
  if (typeof targetRequestId !== "string" || !targetRequestId.trim())
    throw new RuntimeCommandInputError("command_target_required");
  return Object.freeze({ name, mode: "steer", targetRequestId });
}

function hasEmptyCommandArguments(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).length === 0;
}
