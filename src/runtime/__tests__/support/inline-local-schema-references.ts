/** Test-only expansion: validate the referenced constraints with the existing subset validator. */
export function inlineLocalSchemaReferences(
  root: Record<string, unknown>,
): Record<string, unknown> {
  function expand(
    node: Record<string, unknown>,
    references: readonly string[],
    depth: number,
  ): Record<string, unknown> {
    if (depth > 64) throw new Error("test_schema_expansion_depth_exceeded");
    if (Object.hasOwn(node, "$ref")) {
      const reference = node.$ref;
      if (typeof reference !== "string" || !reference.startsWith("#/$defs/"))
        throw new Error("test_schema_reference_unsupported");
      if (references.includes(reference))
        throw new Error("test_schema_reference_cycle");
      let target: unknown = root;
      for (const segment of reference.slice(2).split("/")) {
        if (/~(?![01])/u.test(segment))
          throw new Error("test_schema_pointer_invalid");
        const key = segment.replace(/~1/gu, "/").replace(/~0/gu, "~");
        if (!isSchemaRecord(target) || !Object.hasOwn(target, key))
          throw new Error("test_schema_reference_missing");
        target = target[key];
      }
      if (!isSchemaRecord(target))
        throw new Error("test_schema_reference_not_object");
      const resolved = expand(target, [...references, reference], depth + 1);
      const { $ref: _reference, ...siblings } = node;
      if (Object.keys(siblings).length === 0) return resolved;
      return { allOf: [resolved, expand(siblings, references, depth + 1)] };
    }
    const { $defs: _definitions, ...result } = node;
    for (const key of ["properties", "patternProperties", "dependentSchemas"]) {
      if (!isSchemaRecord(node[key])) continue;
      result[key] = Object.fromEntries(
        Object.entries(node[key]).map(([name, child]) => [
          name,
          isSchemaRecord(child) ? expand(child, references, depth + 1) : child,
        ]),
      );
    }
    for (const key of [
      "items",
      "additionalProperties",
      "not",
      "if",
      "then",
      "else",
    ]) {
      if (isSchemaRecord(node[key]))
        result[key] = expand(node[key], references, depth + 1);
    }
    for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
      if (!Array.isArray(node[key])) continue;
      result[key] = node[key].map((child) =>
        isSchemaRecord(child) ? expand(child, references, depth + 1) : child,
      );
    }
    return result;
  }
  return expand(root, [], 0);
}

function isSchemaRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
