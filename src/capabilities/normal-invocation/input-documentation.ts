import type {
  ToolNormalInvocationInput,
  ToolNormalInvocationPropertyInput,
} from "./contracts.js";
import { isPlainObject } from "./contract-fields.js";
import { validateToolNormalInvocationPropertyValue } from "./input-value.js";

export const TOOL_INPUT_DESCRIPTION_MAX_LENGTH = 512;
export const TOOL_INPUT_EXAMPLE_MAX_LENGTH = 1_024;

/** Plugin-owned explanatory data. Examples never supply missing arguments. */
export type ToolInputDocumentation = Readonly<{
  description?: string;
  example?: string | number | boolean | readonly (string | number | boolean)[];
}>;

type InputDocumentationNormalization =
  | Readonly<{ ok: true; value: ToolInputDocumentation }>
  | Readonly<{ ok: false; issue: string }>;

export function normalizeToolInputDocumentation(
  input: unknown,
  schema: ToolNormalInvocationPropertyInput,
): InputDocumentationNormalization {
  if (!isPlainObject(input)) {
    return { ok: false, issue: "input documentation must be an object" };
  }
  if (!hasOnlyInputDocumentationKeys(input)) {
    return {
      ok: false,
      issue: "input documentation permits only description and example",
    };
  }
  const hasDescription = Object.hasOwn(input, "description");
  if (hasDescription && !isBoundedInputDescription(input.description)) {
    return {
      ok: false,
      issue: `description must be non-empty text of at most ${TOOL_INPUT_DESCRIPTION_MAX_LENGTH} characters`,
    };
  }
  const hasExample = Object.hasOwn(input, "example");
  const exampleIssue = validateOptionalInputExample(input, schema);
  if (exampleIssue) return { ok: false, issue: exampleIssue };
  return {
    ok: true,
    value: Object.freeze({
      ...(hasDescription
        ? { description: (input.description as string).trim() }
        : {}),
      ...(hasExample ? { example: captureInputExample(input.example) } : {}),
    }),
  };
}

function validateOptionalInputExample(
  input: Record<string, unknown>,
  schema: ToolNormalInvocationPropertyInput,
): string | undefined {
  if (!Object.hasOwn(input, "example")) return undefined;
  const issue = validateToolNormalInvocationPropertyValue(schema, input.example, "example");
  if (issue) return issue;
  if (!isInputExampleWithinBudget(input.example)) {
    return `example must serialize to at most ${TOOL_INPUT_EXAMPLE_MAX_LENGTH} characters`;
  }
  return undefined;
}

function isBoundedInputDescription(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.trim().length === 0) return false;
  return value.length <= TOOL_INPUT_DESCRIPTION_MAX_LENGTH;
}

function hasOnlyInputDocumentationKeys(
  input: Record<string, unknown>,
): boolean {
  return Object.keys(input).every(
    (key) => key === "description" || key === "example",
  );
}

function isInputExampleWithinBudget(value: unknown): boolean {
  return JSON.stringify(value).length <= TOOL_INPUT_EXAMPLE_MAX_LENGTH;
}

function captureInputExample(
  value: unknown,
): Exclude<ToolInputDocumentation["example"], undefined> {
  if (Array.isArray(value))
    return Object.freeze([...value]) as readonly (string | number | boolean)[];
  return value as string | number | boolean;
}

/** Preserve structural-only consumers and identities when documentation changes. */
export function stripToolInputDocumentation(
  input: ToolNormalInvocationInput,
): ToolNormalInvocationInput {
  const properties = Object.fromEntries(
    Object.entries(input.properties).map(([name, property]) => {
      if (!isPlainObject(property)) return [name, property];
      const {
        description: _description,
        example: _example,
        ...structural
      } = property;
      return [name, Object.freeze(structural)];
    }),
  );
  return Object.freeze({ ...input, properties: Object.freeze(properties) });
}
