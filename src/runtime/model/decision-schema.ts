import type { ToolNormalInvocationInput } from "../../capabilities/normal-invocation/contracts.js";

/** Each alternative is a closed object. Only optional fields in that alternative can be null. */
export function projectStrictControlsSchema(schema: ToolNormalInvocationInput): Record<string, unknown> {
  function projectObject(controlIds: readonly string[]): Record<string, unknown> {
    const properties = Object.fromEntries(controlIds.map((id) => [
      id,
      schema.required.includes(id)
        ? schema.properties[id]!
        : { anyOf: [schema.properties[id]!, { type: "null" }] },
    ]));
    return { type: "object", properties, required: controlIds, additionalProperties: false };
  }

  if (!schema.anyOf) return projectObject(Object.keys(schema.properties));
  return { anyOf: schema.anyOf.map(({ propertyNames }) => projectObject([...propertyNames.enum].sort())) };
}

/** Metadata for providers that omit a constraint already enforced by the domain parser. */
export function collectDecisionMaxLengthConstraints(
  value: unknown,
  path = "",
): Array<Readonly<{ keyword: "maxLength"; path: string }>> {
  if (Array.isArray(value))
    return value.flatMap((entry, index) => collectDecisionMaxLengthConstraints(entry, `${path}/${index}`));
  if (value === null || typeof value !== "object") return [];
  return [
    ...(typeof (value as Record<string, unknown>).maxLength === "number" ? [{ keyword: "maxLength" as const, path: `${path}/maxLength` }] : []),
    ...Object.entries(value).flatMap(([key, child]) =>
      collectDecisionMaxLengthConstraints(child, `${path}/${escapeJsonPointer(key)}`)),
  ];
}

function escapeJsonPointer(input: string): string {
  return input.replace(/~/gu, "~0").replace(/\//gu, "~1");
}
