import type {
  ModelGatewayFormat,
  ModelGatewayJsonSchemaFormat,
} from "../types.js";

const INTERNAL_PROJECTION_METADATA_KEYS = [
  "postValidatedSchemaConstraints",
  "postValidatedSchemaKeywords",
] as const;

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isModelGatewayJsonSchemaFormat(
  value: unknown,
): value is ModelGatewayJsonSchemaFormat {
  if (!isPlainObject(value)) {
    return false;
  }
  const hasSchemaName =
    typeof value.name === "string" && value.name.trim().length > 0;
  return (
    value.type === "json_schema" && hasSchemaName && isPlainObject(value.schema)
  );
}

export function resolveModelGatewayFormat(
  requestedFormat: unknown,
  fallbackFormat?: ModelGatewayFormat,
): ModelGatewayFormat | undefined {
  const isSupportedRequestFormat =
    requestedFormat === "json" || isPlainObject(requestedFormat);
  return isSupportedRequestFormat ? requestedFormat : fallbackFormat;
}

export function rejectMisplacedProjectionMetadata(
  format: Record<string, unknown>,
): void {
  const hasInternalMetadata = INTERNAL_PROJECTION_METADATA_KEYS.some(
    (key) => key in format,
  );
  if (hasInternalMetadata) {
    throw new TypeError(
      "Provider projection metadata requires a valid json_schema format wrapper.",
    );
  }
}
