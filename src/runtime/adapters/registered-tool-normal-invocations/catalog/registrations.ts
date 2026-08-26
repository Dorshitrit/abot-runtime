import { parseToolNormalInvocationForDefinition } from "../../../../capabilities/normal-invocation/index.js";
import type {
  RegisteredToolNormalInvocation,
  ToolCallAdapter,
} from "../../../../capabilities/tool-types.js";

export function captureNormalInvocationRegistrations(
  registrations: readonly RegisteredToolNormalInvocation[],
): readonly RegisteredToolNormalInvocation[] {
  const names = new Set<string>();
  const captured = registrations.map((registration) => {
    if (names.has(registration.toolName)) {
      throw new TypeError(
        `Duplicate ordinary invocation registration: ${registration.toolName}`,
      );
    }
    names.add(registration.toolName);
    if (registration.toolName !== registration.definition.name) {
      throw new TypeError(
        `Ordinary invocation registration name mismatch: ${registration.toolName}`,
      );
    }
    const contract = parseToolNormalInvocationForDefinition(
      registration.definition,
      registration.contract,
    );
    if (!contract) {
      throw new TypeError(
        `Ordinary invocation registration is missing a contract: ${registration.toolName}`,
      );
    }
    const adapter = captureAdapter(registration.toolName, registration.adapter);
    return Object.freeze({
      toolName: registration.toolName,
      definition: registration.definition,
      contract,
      ...(adapter ? { adapter } : {}),
    });
  });
  return Object.freeze(captured);
}

function captureAdapter(
  toolName: string,
  adapter: ToolCallAdapter | undefined,
): ToolCallAdapter | undefined {
  if (!adapter) return undefined;
  const normalizeCall = adapter.normalizeCall;
  const validateCall = adapter.validateCall;
  if (
    (normalizeCall !== undefined && typeof normalizeCall !== "function") ||
    (validateCall !== undefined && typeof validateCall !== "function")
  ) {
    throw new TypeError(
      `Invalid ordinary invocation adapter registration: ${toolName}`,
    );
  }
  return Object.freeze({
    ...(normalizeCall ? { normalizeCall } : {}),
    ...(validateCall ? { validateCall } : {}),
  });
}
