const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_VISITS = 50_000;
const MAX_SERIALIZED_NUMBER_CHARACTERS = Math.max(
  JSON.stringify(Number.MAX_VALUE).length,
  JSON.stringify(-Number.MAX_VALUE).length,
  JSON.stringify(Number.MIN_VALUE).length,
  JSON.stringify(-Number.MIN_VALUE).length,
);

type SchemaEstimateState = {
  visits: number;
};

export function estimateStrictSchemaCharacters(
  schema: Readonly<Record<string, unknown>>,
): number | undefined {
  return estimateSchemaNodeCharacters(schema, 0, {
    visits: 0,
  });
}

function estimateSchemaNodeCharacters(
  schema: Readonly<Record<string, unknown>>,
  depth: number,
  state: SchemaEstimateState,
): number | undefined {
  state.visits += 1;
  if (depth > MAX_SCHEMA_DEPTH || state.visits > MAX_SCHEMA_VISITS) {
    return undefined;
  }

  const bounds: number[] = [];
  const constantBound = estimateExactJsonCharacters(schema.const);
  if (Object.hasOwn(schema, "const") && constantBound !== undefined) {
    bounds.push(constantBound);
  }
  const enumBound = estimateEnumCharacters(schema.enum);
  if (enumBound !== undefined) {
    bounds.push(enumBound);
  }
  const typeBound = estimateDeclaredTypeCharacters(schema, depth, state);
  if (typeBound !== undefined) {
    bounds.push(typeBound);
  }
  for (const union of [schema.anyOf, schema.oneOf]) {
    const unionBound = estimateUnionCharacters(union, depth, state);
    if (unionBound !== undefined) {
      bounds.push(unionBound);
    }
  }
  const intersectionBound = estimateIntersectionCharacters(
    schema.allOf,
    depth,
    state,
  );
  if (intersectionBound !== undefined) {
    bounds.push(intersectionBound);
  }

  return bounds.length > 0 ? minimum(bounds) : undefined;
}

function estimateDeclaredTypeCharacters(
  schema: Readonly<Record<string, unknown>>,
  depth: number,
  state: SchemaEstimateState,
): number | undefined {
  const types = readDeclaredTypes(schema);
  if (types.length === 0) {
    return undefined;
  }
  const bounds = types.map((type) =>
    estimateTypeCharacters(type, schema, depth, state),
  );
  return bounds.every((bound): bound is number => bound !== undefined)
    ? maximum(bounds)
    : undefined;
}

function readDeclaredTypes(
  schema: Readonly<Record<string, unknown>>,
): string[] {
  if (Array.isArray(schema.type)) {
    return schema.type.filter(
      (value): value is string => typeof value === "string",
    );
  }
  if (typeof schema.type === "string") {
    return [schema.type];
  }
  return inferStructuralType(schema);
}

function inferStructuralType(
  schema: Readonly<Record<string, unknown>>,
): string[] {
  if (Object.hasOwn(schema, "properties")) return ["object"];
  if (Object.hasOwn(schema, "items")) return ["array"];
  return [];
}

function estimateTypeCharacters(
  type: string,
  schema: Readonly<Record<string, unknown>>,
  depth: number,
  state: SchemaEstimateState,
): number | undefined {
  switch (type) {
    case "null":
      return 4;
    case "boolean":
      return 5;
    case "number":
    case "integer":
      return MAX_SERIALIZED_NUMBER_CHARACTERS;
    case "string": {
      const maxLength = readNonNegativeInteger(schema.maxLength);
      return maxLength === undefined ? undefined : safeAdd(maxLength, 2);
    }
    case "array":
      return estimateArrayCharacters(schema, depth, state);
    case "object":
      return estimateObjectCharacters(schema, depth, state);
    default:
      return undefined;
  }
}

function estimateArrayCharacters(
  schema: Readonly<Record<string, unknown>>,
  depth: number,
  state: SchemaEstimateState,
): number | undefined {
  const maxItems = readNonNegativeInteger(schema.maxItems);
  if (maxItems === undefined) return undefined;
  if (maxItems === 0) return 2;

  if (isPlainRecord(schema.items)) {
    const itemCharacters = estimateSchemaNodeCharacters(
      schema.items,
      depth + 1,
      state,
    );
    return itemCharacters === undefined
      ? undefined
      : safeAdd(
          2,
          safeAdd(maxItems - 1, safeMultiply(maxItems, itemCharacters)),
        );
  }

  if (!Array.isArray(schema.items)) return undefined;
  if (!schema.items.every(isPlainRecord)) return undefined;
  const itemSchemas = schema.items;
  const effectiveMaxItems =
    schema.additionalItems === false
      ? Math.min(maxItems, itemSchemas.length)
      : maxItems;
  const fixedItemCount = Math.min(effectiveMaxItems, itemSchemas.length);
  let characters = safeAdd(2, Math.max(0, effectiveMaxItems - 1));
  for (let index = 0; index < fixedItemCount; index += 1) {
    const itemCharacters = estimateSchemaNodeCharacters(
      itemSchemas[index]!,
      depth + 1,
      state,
    );
    if (itemCharacters === undefined) return undefined;
    characters = safeAdd(characters, itemCharacters);
  }
  if (effectiveMaxItems <= itemSchemas.length) return characters;
  if (!isPlainRecord(schema.additionalItems)) return undefined;
  const additionalCharacters = estimateSchemaNodeCharacters(
    schema.additionalItems,
    depth + 1,
    state,
  );
  return additionalCharacters === undefined
    ? undefined
    : safeAdd(
        characters,
        safeMultiply(
          effectiveMaxItems - itemSchemas.length,
          additionalCharacters,
        ),
      );
}

function estimateObjectCharacters(
  schema: Readonly<Record<string, unknown>>,
  depth: number,
  state: SchemaEstimateState,
): number | undefined {
  const hasPatternProperties =
    isPlainRecord(schema.patternProperties) &&
    Object.keys(schema.patternProperties).length > 0;
  const allowsUnboundedProperties = schema.additionalProperties !== false;
  if (allowsUnboundedProperties || hasPatternProperties) {
    return undefined;
  }
  if (schema.properties !== undefined && !isPlainRecord(schema.properties)) {
    return undefined;
  }
  const properties = isPlainRecord(schema.properties)
    ? Object.entries(schema.properties)
    : [];
  let characters = safeAdd(2, Math.max(0, properties.length - 1));
  for (const [property, propertySchema] of properties) {
    if (!isPlainRecord(propertySchema)) return undefined;
    const valueCharacters = estimateSchemaNodeCharacters(
      propertySchema,
      depth + 1,
      state,
    );
    if (valueCharacters === undefined) return undefined;
    characters = safeAdd(
      characters,
      safeAdd(JSON.stringify(property).length + 1, valueCharacters),
    );
  }
  return characters;
}

function estimateUnionCharacters(
  value: unknown,
  depth: number,
  state: SchemaEstimateState,
): number | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const branches = value.filter(isPlainRecord);
  if (branches.length !== value.length) return undefined;
  const bounds = branches.map((branch) =>
    estimateSchemaNodeCharacters(branch, depth + 1, state),
  );
  return bounds.every((bound): bound is number => bound !== undefined)
    ? maximum(bounds)
    : undefined;
}

function estimateIntersectionCharacters(
  value: unknown,
  depth: number,
  state: SchemaEstimateState,
): number | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const bounds = value
    .filter(isPlainRecord)
    .map((branch) => estimateSchemaNodeCharacters(branch, depth + 1, state))
    .filter((bound): bound is number => bound !== undefined);
  return bounds.length > 0 ? minimum(bounds) : undefined;
}

function estimateEnumCharacters(value: unknown): number | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const bounds = value.map(estimateExactJsonCharacters);
  return bounds.every((bound): bound is number => bound !== undefined)
    ? maximum(bounds)
    : undefined;
}

function estimateExactJsonCharacters(value: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized.length : undefined;
  } catch {
    return undefined;
  }
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function safeMultiply(left: number, right: number): number {
  if (left === 0 || right === 0) return 0;
  return left > Number.MAX_SAFE_INTEGER / right
    ? Number.MAX_SAFE_INTEGER
    : left * right;
}

function minimum(values: readonly number[]): number {
  return values.reduce((result, value) => Math.min(result, value));
}

function maximum(values: readonly number[]): number {
  return values.reduce((result, value) => Math.max(result, value));
}
