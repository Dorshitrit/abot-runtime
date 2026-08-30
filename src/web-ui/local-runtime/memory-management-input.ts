import type { MemoryListInput } from "../../runtime/long-term-memory/contracts.js";
import { LongTermMemoryManagementError } from "../../runtime/long-term-memory/index.js";
import type { JsonObject } from "./contracts.js";

const ENVIRONMENT_FIELDS = ["environment", "environmentId"] as const;

export type WebMemoryCreateInput = Readonly<{
  content: string;
  tags: readonly string[];
}>;

export type WebMemoryUpdateInput = WebMemoryCreateInput &
  Readonly<{ expectedUpdatedAt: string }>;

export function readMemoryPage(url: URL): MemoryListInput {
  const limit = readOptionalInteger(url, "limit", false);
  const offset = readOptionalInteger(url, "offset", true);
  return Object.freeze({
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
  });
}

export function readMemoryCreateInput(
  body: JsonObject | null,
): WebMemoryCreateInput {
  assertAllowedFields(body, ["content", "tags", ...ENVIRONMENT_FIELDS]);
  return Object.freeze({
    content: readString(body?.content),
    tags: readTags(body?.tags),
  });
}

export function readMemoryUpdateInput(
  body: JsonObject | null,
): WebMemoryUpdateInput {
  assertAllowedFields(body, [
    "content",
    "tags",
    "expectedUpdatedAt",
    ...ENVIRONMENT_FIELDS,
  ]);
  return Object.freeze({
    content: readString(body?.content),
    tags: readTags(body?.tags),
    expectedUpdatedAt: readString(body?.expectedUpdatedAt),
  });
}

function assertAllowedFields(
  body: JsonObject | null,
  allowedFields: readonly string[],
): void {
  const fields = Object.keys(body ?? {});
  if (fields.some((field) => !allowedFields.includes(field))) {
    throw invalidManagementInput();
  }
}

function readString(value: unknown): string {
  if (typeof value !== "string") {
    throw invalidManagementInput();
  }
  return value;
}

function readTags(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  const validTags = Array.isArray(value) && value.every(isString);
  if (!validTags) {
    throw invalidManagementInput();
  }
  return Object.freeze([...value]);
}

function readOptionalInteger(
  url: URL,
  name: string,
  allowZero: boolean,
): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  const validRange = allowZero ? value >= 0 : value > 0;
  if (!Number.isSafeInteger(value) || !validRange || String(value) !== raw) {
    throw invalidManagementInput();
  }
  return value;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function invalidManagementInput(): LongTermMemoryManagementError {
  return new LongTermMemoryManagementError(
    "long_term_memory_management_input_invalid",
  );
}
