export function requireConfigString(
  value: unknown,
  configPath: string,
  field: string,
): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  throw invalidRuntimeConfig(configPath, `${field} must be a string`);
}

export function requireConfigRecord(
  value: unknown,
  configPath: string,
  field: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidRuntimeConfig(configPath, `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function requireConfigStringMap(
  value: unknown,
  configPath: string,
  field: string,
): Record<string, string> {
  const record = requireConfigRecord(value, configPath, field);
  return Object.fromEntries(
    Object.entries(record).map(([key, rawValue]) => [
      key,
      requireConfigString(rawValue, configPath, `${field}.${key}`),
    ]),
  );
}

export function requireConfigStringArray(
  value: unknown,
  configPath: string,
  field: string,
): string[] {
  if (!Array.isArray(value)) {
    throw invalidRuntimeConfig(configPath, `${field} must be an array`);
  }
  return [
    ...new Set(
      value.map((entry, index) =>
        requireConfigString(entry, configPath, `${field}[${index}]`),
      ),
    ),
  ];
}

export function requireExactConfigKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  configPath: string,
  field: string,
): void {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (
    actual.length !== expected.size ||
    actual.some((key) => !expected.has(key))
  ) {
    throw invalidRuntimeConfig(
      configPath,
      `${field} must contain exactly: ${keys.join(", ")}`,
    );
  }
}

/** Parsed config is process-scoped authority; consumers must not mutate it. */
export function deepFreezeConfig<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreezeConfig(child);
  }
  return Object.freeze(value);
}

export function requirePositiveConfigInteger(
  value: unknown,
  configPath: string,
  field: string,
): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  throw invalidRuntimeConfig(configPath, `${field} must be a positive integer`);
}

export function invalidRuntimeConfig(configPath: string, issue: string): Error {
  return new Error(
    `Invalid runtime request runner config at ${configPath}: ${issue}`,
  );
}

export function formatConfigError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
