import type { JsonObject } from "./contracts.js";

export function agentInputText(value: unknown, maximum: number, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(`agents_input_${field}`);
  return value;
}
export function agentInputBody(value: JsonObject | null, fields: readonly string[]): JsonObject {
  if (!value) throw new Error("agents_input_body");
  const allowed = new Set([...fields, "environment", "environmentId"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("agents_input_fields");
  const { environment: _environment, environmentId: _environmentId, ...body } = value;
  return body;
}
