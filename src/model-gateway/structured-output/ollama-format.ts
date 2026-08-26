import type {
  ModelGatewayFormat,
  ModelGatewayJsonSchemaFormat,
} from "../types.js";
import {
  isModelGatewayJsonSchemaFormat,
  isPlainObject,
  rejectMisplacedProjectionMetadata,
} from "./format-contract.js";

const OLLAMA_UNSUPPORTED_SCHEMA_KEYWORDS = new Set(["maxLength"] as const);

export type OllamaSchemaProjectionDiagnostic = Readonly<{
  action: "removed";
  keyword: "maxLength";
  path: string;
  reason: "ollama_grammar_unsupported_post_validated_constraint";
}>;

export type OllamaFormatProjection = Readonly<{
  format: "json" | Record<string, unknown> | undefined;
  diagnostics: readonly OllamaSchemaProjectionDiagnostic[];
}>;

type PostValidatedConstraint = Readonly<{
  keyword: "maxLength";
  path: string;
}>;

function appendJsonPointer(path: string, segment: string): string {
  const escaped = segment.replace(/~/g, "~0").replace(/\//g, "~1");
  return `${path}/${escaped}`;
}

function isValidJsonPointer(value: string): boolean {
  const hasInvalidEscape = value
    .split("/")
    .slice(1)
    .some((segment) => /~(?![01])/u.test(segment));
  return value.startsWith("/") && !hasInvalidEscape;
}

function isValidPostValidatedConstraint(
  value: unknown,
): value is PostValidatedConstraint {
  if (!isPlainObject(value)) {
    return false;
  }
  const hasOnlyContractFields = Object.keys(value).every(
    (key) => key === "keyword" || key === "path",
  );
  return (
    value.keyword === "maxLength" &&
    typeof value.path === "string" &&
    isValidJsonPointer(value.path) &&
    hasOnlyContractFields
  );
}

function constraintKey(keyword: "maxLength", path: string): string {
  return `${keyword}\u0000${path}`;
}

function constraintPath(key: string): string {
  return key.slice(key.indexOf("\u0000") + 1);
}

function readPostValidatedConstraints(
  format: ModelGatewayJsonSchemaFormat,
): ReadonlySet<string> {
  if ("postValidatedSchemaKeywords" in format) {
    throw new TypeError(
      `Legacy post-validated schema keyword declaration is not accepted for ${format.name}.`,
    );
  }
  const constraints = format.postValidatedSchemaConstraints;
  if (constraints === undefined) {
    return new Set();
  }
  if (!Array.isArray(constraints)) {
    throw new TypeError(
      `Invalid post-validated schema constraint declaration for ${format.name}.`,
    );
  }

  const keys = new Set<string>();
  for (const constraint of constraints) {
    if (!isValidPostValidatedConstraint(constraint)) {
      throw new TypeError(
        `Invalid post-validated schema constraint declaration for ${format.name}.`,
      );
    }
    const key = constraintKey(constraint.keyword, constraint.path);
    if (keys.has(key)) {
      throw new TypeError(
        `Duplicate post-validated schema constraint declaration for ${format.name}: ${constraint.path}.`,
      );
    }
    keys.add(key);
  }
  return keys;
}

function projectOllamaSchemaNode(params: {
  value: unknown;
  path: string;
  postValidatedConstraints: ReadonlySet<string>;
  consumedConstraints: Set<string>;
  diagnostics: OllamaSchemaProjectionDiagnostic[];
}): unknown {
  if (Array.isArray(params.value)) {
    return params.value.map((entry, index) =>
      projectOllamaSchemaNode({
        ...params,
        value: entry,
        path: appendJsonPointer(params.path, String(index)),
      }),
    );
  }
  if (!isPlainObject(params.value)) {
    return params.value;
  }

  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params.value)) {
    if (OLLAMA_UNSUPPORTED_SCHEMA_KEYWORDS.has(key as "maxLength")) {
      const path = appendJsonPointer(params.path, key);
      const constraint = constraintKey(key as "maxLength", path);
      if (!params.postValidatedConstraints.has(constraint)) {
        throw new Error(`ollama_schema_constraint_not_post_validated:${path}`);
      }
      params.consumedConstraints.add(constraint);
      params.diagnostics.push(
        Object.freeze({
          action: "removed",
          keyword: "maxLength",
          path,
          reason:
            "ollama_grammar_unsupported_post_validated_constraint" as const,
        }),
      );
      continue;
    }
    projected[key] = projectOllamaSchemaNode({
      ...params,
      value,
      path: appendJsonPointer(params.path, key),
    });
  }
  return projected;
}

function projectWrappedJsonSchema(
  format: ModelGatewayJsonSchemaFormat,
): OllamaFormatProjection {
  const postValidatedConstraints = readPostValidatedConstraints(format);
  const consumedConstraints = new Set<string>();
  const diagnostics: OllamaSchemaProjectionDiagnostic[] = [];
  const schema = projectOllamaSchemaNode({
    value: format.schema,
    path: "",
    postValidatedConstraints,
    consumedConstraints,
    diagnostics,
  }) as Record<string, unknown>;

  for (const constraint of postValidatedConstraints) {
    if (!consumedConstraints.has(constraint)) {
      throw new Error(
        `ollama_post_validated_constraint_not_found:${constraintPath(constraint)}`,
      );
    }
  }
  return { format: schema, diagnostics: Object.freeze(diagnostics) };
}

export function projectOllamaFormat(
  format: ModelGatewayFormat | undefined,
): OllamaFormatProjection {
  if (format === "json") {
    return { format: "json", diagnostics: [] };
  }
  if (!isPlainObject(format)) {
    return { format: undefined, diagnostics: [] };
  }
  if (isModelGatewayJsonSchemaFormat(format)) {
    return projectWrappedJsonSchema(format);
  }
  if (format.type === "json_object") {
    rejectMisplacedProjectionMetadata(format);
    return { format: "json", diagnostics: [] };
  }

  rejectMisplacedProjectionMetadata(format);
  return {
    format: projectOllamaSchemaNode({
      value: format,
      path: "",
      postValidatedConstraints: new Set(),
      consumedConstraints: new Set(),
      diagnostics: [],
    }) as Record<string, unknown>,
    diagnostics: [],
  };
}

export function toOllamaFormat(
  format: ModelGatewayFormat | undefined,
): "json" | Record<string, unknown> | undefined {
  return projectOllamaFormat(format).format;
}
