import type { MemoryCandidate } from "../contracts.js";
import {
  isMemoryCandidateWithinLimits,
  normalizeMemoryCandidate,
  normalizeMemoryIdentifier,
  normalizeMemoryText,
} from "../policies/normalization.js";
import { containsSensitiveMemoryCandidateData } from "../policies/sensitive-data.js";
import type {
  MemoryCreateInput,
  MemoryListInput,
  MemoryManagementSource,
  MemoryUpdateInput,
} from "./contracts.js";
import { LongTermMemoryManagementError } from "./errors.js";

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
const MAX_SEARCH_QUERY_CHARACTERS = 4_000;

export type MemoryPage = Readonly<{ limit: number; offset: number }>;

export function prepareCreatedMemory(
  input: MemoryCreateInput,
): Readonly<{ candidate: MemoryCandidate; source: MemoryManagementSource }> {
  const candidate = prepareManualCandidate(input.content, input.tags);
  if (input.source !== "web_ui" && input.source !== "management_api") {
    throw new LongTermMemoryManagementError(
      "long_term_memory_management_input_invalid",
    );
  }
  return Object.freeze({ candidate, source: input.source });
}

export function prepareUpdatedMemory(input: MemoryUpdateInput): Readonly<{
  id: string;
  expectedUpdatedAt: string;
  candidate: MemoryCandidate;
}> {
  const id = normalizeMemoryId(input.id);
  const expectedUpdatedAt = input.expectedUpdatedAt.trim();
  if (!isTimestamp(expectedUpdatedAt)) {
    throw new LongTermMemoryManagementError(
      "long_term_memory_management_input_invalid",
      { memoryId: id },
    );
  }
  return Object.freeze({
    id,
    expectedUpdatedAt,
    candidate: prepareManualCandidate(input.content, input.tags),
  });
}

export function normalizeMemoryId(value: string): string {
  const id = normalizeMemoryIdentifier(value);
  if (!id) {
    throw new LongTermMemoryManagementError(
      "long_term_memory_management_input_invalid",
    );
  }
  return id;
}

export function normalizeSearchQuery(value: string): string {
  const query = typeof value === "string" ? value.trim() : "";
  if (!query || query.length > MAX_SEARCH_QUERY_CHARACTERS) {
    throw new LongTermMemoryManagementError(
      "long_term_memory_management_input_invalid",
    );
  }
  return query;
}

export function normalizeMemoryPage(input: MemoryListInput = {}): MemoryPage {
  const offset = normalizeNonNegativeInteger(input.offset, 0);
  const limit = Math.min(
    normalizePositiveInteger(input.limit, DEFAULT_LIST_LIMIT),
    MAX_LIST_LIMIT,
  );
  return Object.freeze({ limit, offset });
}

export function findExactMemoryDuplicate(
  records: readonly Readonly<{ id: string; content: string }>[],
  content: string,
  excludedId?: string,
): Readonly<{ id: string }> | undefined {
  const key = normalizeMemoryText(content);
  return records.find(
    (record) =>
      record.id !== excludedId && normalizeMemoryText(record.content) === key,
  );
}

function prepareManualCandidate(
  content: string,
  tags: readonly string[],
): MemoryCandidate {
  if (typeof content !== "string" || !Array.isArray(tags)) {
    throw new LongTermMemoryManagementError(
      "long_term_memory_management_input_invalid",
    );
  }
  if (!isMemoryCandidateWithinLimits({ content, tags })) {
    throw new LongTermMemoryManagementError(
      "long_term_memory_management_input_invalid",
    );
  }
  const candidate = normalizeMemoryCandidate({ content, tags });
  if (!candidate) {
    throw new LongTermMemoryManagementError(
      "long_term_memory_management_input_invalid",
    );
  }
  if (containsSensitiveMemoryCandidateData(candidate)) {
    throw new LongTermMemoryManagementError(
      "long_term_memory_management_sensitive_data",
    );
  }
  return candidate;
}

function isTimestamp(value: string): boolean {
  return value.length > 0 && Number.isFinite(Date.parse(value));
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : fallback;
}

function normalizeNonNegativeInteger(
  value: number | undefined,
  fallback: number,
): number {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : fallback;
}
