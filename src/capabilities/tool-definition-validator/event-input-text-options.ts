import type { ToolEventMetadataProjection } from "../tool-types.js";
import { TOOL_EVENT_INPUT_TEXT_MAX_LENGTH } from "../tool-event-input-text.js";

type InputTextOptions = Pick<
  ToolEventMetadataProjection,
  "maxLength" | "preserveWhitespace"
>;

/** The same optional input-text contract applies to manifests and tool modules. */
export function parseEventInputTextOptions(
  projection: Record<string, unknown>,
  path: string,
): InputTextOptions {
  const { maxLength, preserveWhitespace } = projection;
  if (maxLength === undefined && preserveWhitespace === undefined) return {};
  if (!supportsInputTextOptions(projection.kind)) {
    throw new Error(`${path} text options require kind string or string_array`);
  }
  if (maxLength !== undefined && projection.kind !== "string") {
    throw new Error(`${path}.maxLength requires kind string`);
  }
  if (!hasSupportedInputTextLength(maxLength)) {
    throw new Error(
      `${path}.maxLength must be an integer from 1 to ${TOOL_EVENT_INPUT_TEXT_MAX_LENGTH}`,
    );
  }
  if (!hasSupportedWhitespaceOption(preserveWhitespace)) {
    throw new Error(`${path}.preserveWhitespace must be a boolean`);
  }
  return {
    ...(maxLength !== undefined ? { maxLength } : {}),
    ...(preserveWhitespace !== undefined ? { preserveWhitespace } : {}),
  };
}

function hasSupportedInputTextLength(
  value: unknown,
): value is number | undefined {
  if (value === undefined) return true;
  if (typeof value !== "number" || !Number.isInteger(value)) return false;
  return value >= 1 && value <= TOOL_EVENT_INPUT_TEXT_MAX_LENGTH;
}

function hasSupportedWhitespaceOption(
  value: unknown,
): value is boolean | undefined {
  if (value === undefined) return true;
  return typeof value === "boolean";
}

function supportsInputTextOptions(kind: unknown): boolean {
  return kind === "string" || kind === "string_array";
}
