export const TOOL_NORMAL_INVOCATION_VERSION = 1 as const;
export const TOOL_NORMAL_INVOCATION_IDENTIFIER_MAX_LENGTH = 64;
export const TOOL_NORMAL_INVOCATION_PAYLOAD_MAX_BYTES = 16 * 1_024 * 1_024;

export type ToolNormalInvocationEffect = "read_only" | "mutating" | "mixed";

export type ToolNormalInvocationApproval = "request_policy" | "always";

export type ToolNormalInvocationFixedValue = string | number | boolean;

export type ToolNormalInvocationBoundedStringInput = Readonly<{
  type: "string";
  minLength: number;
  maxLength: number;
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

export type ToolNormalInvocationPropertyInput =
  | ToolNormalInvocationScalarInput
  | ToolNormalInvocationArrayInput;

/**
 * Provider-safe v1 input subset. The object is deliberately exact and flat:
 * command variants are separate operations and nested objects/unions are not
 * part of this contract version.
 */
export type ToolNormalInvocationInput = Readonly<{
  type: "object";
  additionalProperties: false;
  properties: Readonly<Record<string, ToolNormalInvocationPropertyInput>>;
  required: readonly string[];
}>;

export type ToolNormalInvocationPayload = Readonly<{
  kind: "raw_text";
  param: string;
  instructions: string;
  minBytes?: number;
  maxBytes: number;
}>;

export type ToolNormalInvocationOperation = Readonly<{
  operationId: string;
  summary: string;
  input: ToolNormalInvocationInput;
  selectionControlIds?: readonly string[];
  fixedParams?: Readonly<Record<string, ToolNormalInvocationFixedValue>>;
  payload?: ToolNormalInvocationPayload;
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
