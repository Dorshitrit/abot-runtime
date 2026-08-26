import { resolve } from "node:path";

export function parsePathOptions(params: {
  argv: readonly string[];
  allowed: readonly string[];
  required?: readonly string[];
}): Readonly<Record<string, string>> {
  const allowed = new Set(params.allowed);
  const values: Record<string, string> = {};
  for (let index = 0; index < params.argv.length; index += 1) {
    const option = params.argv[index];
    if (!option.startsWith("--") || !allowed.has(option)) {
      throw new Error(`unknown public snapshot option: ${option}`);
    }
    if (Object.hasOwn(values, option)) {
      throw new Error(`duplicate public snapshot option: ${option}`);
    }
    const value = params.argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing path for public snapshot option: ${option}`);
    }
    values[option] = resolve(value);
    index += 1;
  }
  for (const option of params.required ?? []) {
    if (!Object.hasOwn(values, option)) {
      throw new Error(`required public snapshot option is missing: ${option}`);
    }
  }
  return Object.freeze(values);
}
