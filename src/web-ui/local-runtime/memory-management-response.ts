import type { ServerResponse } from "node:http";

import type {
  LongTermMemoryRecord,
  LongTermMemoryStatus,
} from "../../runtime/long-term-memory/contracts.js";
import { isLongTermMemoryManagementError } from "../../runtime/long-term-memory/index.js";
import { sendJson } from "./http.js";
import type { ObservationMemorySource } from "../../runtime/long-term-memory/observation-contracts.js";

export type WebMemoryRecord = Readonly<{
  id: string;
  content: string;
  tags: readonly string[];
  origin:
    | "passive_response"
    | "passive_observation"
    | "web_ui"
    | "management_api";
  createdAt: string;
  updatedAt: string;
  observationSources?: readonly Pick<
    ObservationMemorySource,
    "kind" | "batchId" | "observedAt" | "reason" | "certainty"
  >[];
}>;

export type WebMemoryStatus = Readonly<{
  enabled: boolean;
  available: boolean;
}>;

export function projectWebMemoryStatus(
  status: LongTermMemoryStatus,
): WebMemoryStatus {
  return Object.freeze({
    enabled: status.enabled,
    available: status.available,
  });
}

export function projectWebMemoryRecord(
  record: LongTermMemoryRecord,
): WebMemoryRecord {
  const sources =
    record.provenance.kind === "passive_observation"
      ? [record.provenance, ...(record.observationSources ?? [])]
      : [...(record.observationSources ?? [])];
  return Object.freeze({
    id: record.id,
    content: record.content,
    tags: Object.freeze([...record.tags]),
    origin:
      record.provenance.kind === "manual"
        ? record.provenance.source
        : record.provenance.kind,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(sources.length
      ? {
          observationSources: sources.map(
            ({ kind, batchId, observedAt, reason, certainty }) => ({
              kind,
              batchId,
              observedAt,
              reason,
              certainty,
            }),
          ),
        }
      : {}),
  });
}

export function sendMemoryManagementError(
  response: ServerResponse,
  error: unknown,
): void {
  if (!isLongTermMemoryManagementError(error)) {
    sendJson(response, 500, {
      ok: false,
      error: "long_term_memory_management_failed",
    });
    return;
  }
  sendJson(response, statusForManagementError(error.code), {
    ok: false,
    error: error.code,
    ...(error.memoryId ? { memoryId: error.memoryId } : {}),
  });
}

function statusForManagementError(code: string): number {
  if (
    code === "long_term_memory_management_input_invalid" ||
    code === "long_term_memory_management_sensitive_data"
  ) {
    return 400;
  }
  if (code === "long_term_memory_management_not_found") return 404;
  if (
    code === "long_term_memory_management_conflict" ||
    code === "long_term_memory_management_duplicate"
  ) {
    return 409;
  }
  return 503;
}
