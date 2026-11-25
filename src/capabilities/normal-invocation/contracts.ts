import type { ToolInputDocumentation } from "./input-documentation.js";
import type { ToolInputPropertyModes } from "./input-property-modes.js";
import type { ToolNormalInvocationOutputChannels } from "./output-channels.js";
export type { ToolNormalInvocationOutputChannels, ToolNormalInvocationOutputChannelRole } from "./output-channels.js";

export const TOOL_NORMAL_INVOCATION_VERSION = 1 as const;
export const TOOL_NORMAL_INVOCATION_IDENTIFIER_MAX_LENGTH = 64;
export const TOOL_NORMAL_INVOCATION_INPUT_MAX_PROPERTIES = 16;
export const TOOL_NORMAL_INVOCATION_STRING_MAX_LENGTH = 24_576;
export const TOOL_NORMAL_INVOCATION_PAYLOAD_MAX_BYTES = 16 * 1_024 * 1_024;

export type ToolNormalInvocationEffect = "read_only" | "mutating" | "mixed";

export type ToolNormalInvocationApproval = "request_policy" | "always";

export type ToolNormalInvocationFixedValue = string | number | boolean;

export type ToolNormalInvocationBoundedStringInput = Readonly<{
  type: "string";
  minLength: number;
  maxLength: number;
  pattern?: string;
}>;

export type ToolNormalInvocationUnboundedStringInput = Readonly<{
  type: "string";
  minLength: number;
}>;

export type ToolNormalInvocationEnumInput = Readonly<{
  type: "string";
  enum: readonly string[];
}>;

export type ToolNormalInvocationNumberInput = Readonly<{
  type: "number" | "integer";
  minimum: number;
  maximum: number;
}>;

export type ToolNormalInvocationBooleanInput = Readonly<{
  type: "boolean";
}>;

export type ToolNormalInvocationScalarInput =
  | ToolNormalInvocationBoundedStringInput
  | ToolNormalInvocationUnboundedStringInput
  | ToolNormalInvocationEnumInput
  | ToolNormalInvocationNumberInput
  | ToolNormalInvocationBooleanInput;

export type ToolNormalInvocationArrayInput = Readonly<{
  type: "array";
  items: ToolNormalInvocationScalarInput;
  minItems: number;
  maxItems: number;
}>;

export type ToolNormalInvocationPropertyInput = (
  | ToolNormalInvocationScalarInput
  | ToolNormalInvocationArrayInput
) & ToolInputDocumentation;

/**
 * Provider-safe v1 input subset. The object is deliberately exact and flat:
 * command variants are separate operations. Optional property-name modes only
 * restrict which declared flat controls may occur together.
 */
export type ToolNormalInvocationInput = Readonly<{
  type: "object";
  additionalProperties: false;
  properties: Readonly<Record<string, ToolNormalInvocationPropertyInput>>;
  required: readonly string[];
  anyOf?: ToolInputPropertyModes;
}>;

export type ToolNormalInvocationPayload = Readonly<{
  kind: "raw_text";
  param: string;
  instructions: string;
  minBytes?: number;
  maxBytes: number;
}>;

/** A declared operation input that can resolve a request-owned attachment ID. */
export type ToolNormalInvocationAttachmentInput = Readonly<{
  param: string;
  acceptedMimeTypes: readonly string[];
  mode?: Readonly<{ param: string; value: string }>;
}>;

export type ToolNormalInvocationOperation = Readonly<{
  operationId: string;
  summary: string;
  outputChannels?: ToolNormalInvocationOutputChannels;
  input: ToolNormalInvocationInput;
  selectionControlIds?: readonly string[];
  fixedParams?: Readonly<Record<string, ToolNormalInvocationFixedValue>>;
  payload?: ToolNormalInvocationPayload;
  attachmentInput?: ToolNormalInvocationAttachmentInput;
  effect: ToolNormalInvocationEffect;
  approval: ToolNormalInvocationApproval;
}>;

export type ToolNormalInvocationContract = Readonly<{
  version: typeof TOOL_NORMAL_INVOCATION_VERSION;
  operations: readonly ToolNormalInvocationOperation[];
}>;

export type ToolNormalInvocationInputValidation =
  | Readonly<{
      ok: true;
      value: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      ok: false;
      issue: string;
    }>;
