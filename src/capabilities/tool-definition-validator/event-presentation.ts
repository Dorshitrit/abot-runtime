import type { ToolEventPresentation } from "../tool-types.js";
import { isToolDefinitionRecordValue } from "./definition-shape.js";

const EVENT_PROJECTION_KINDS = [
  "string",
  "number",
  "string_array",
  "length",
] as const;

export function parseEventPresentation(
  toolName: string,
  raw: unknown,
): ToolEventPresentation | undefined {
  if (raw === undefined) return undefined;
  if (!isToolDefinitionRecordValue(raw)) {
    throw invalidEventPresentation(toolName);
  }
  if (!isToolDefinitionRecordValue(raw.metadata)) {
    throw invalidEventPresentation(toolName);
  }
  const metadata = Object.fromEntries(
    Object.entries(raw.metadata).map(([key, projection]) =>
      parseEventMetadataProjection(toolName, key, projection),
    ),
  );
  const lifecycle = parseEventLifecycle(toolName, raw.lifecycle);
  return {
    metadata,
    ...(lifecycle ? { lifecycle } : {}),
  };
}

function parseEventMetadataProjection(
  toolName: string,
  key: string,
  raw: unknown,
): [string, ToolEventPresentation["metadata"][string]] {
  if (!key.trim() || !isToolDefinitionRecordValue(raw)) {
    throw invalidEventMetadataProjection(toolName, key);
  }
  const param = raw.param;
  const kind = raw.kind;
  const fallback = raw.default;
  if (typeof param !== "string" || !param.trim()) {
    throw invalidEventMetadataProjection(toolName, key);
  }
  if (!isEventProjectionKind(kind)) {
    throw invalidEventMetadataProjection(toolName, key);
  }
  if (!hasSupportedEventProjectionDefault(fallback)) {
    throw invalidEventMetadataProjection(toolName, key);
  }
  return [
    key,
    {
      param: param.trim(),
      kind,
      ...(fallback !== undefined ? { default: fallback } : {}),
    },
  ];
}

function isEventProjectionKind(
  value: unknown,
): value is (typeof EVENT_PROJECTION_KINDS)[number] {
  return EVENT_PROJECTION_KINDS.includes(
    value as (typeof EVENT_PROJECTION_KINDS)[number],
  );
}

function hasSupportedEventProjectionDefault(
  value: unknown,
): value is string | number | boolean | undefined {
  if (value === undefined) return true;
  if (typeof value === "string") return true;
  if (typeof value === "number") return true;
  return typeof value === "boolean";
}

function parseEventLifecycle(
  toolName: string,
  raw: unknown,
): ToolEventPresentation["lifecycle"] | undefined {
  if (raw === undefined) return undefined;
  if (!isToolDefinitionRecordValue(raw)) {
    throw new Error(
      `Invalid tool definition for ${toolName} (eventPresentation.lifecycle)`,
    );
  }
  const entries = (["started", "completed", "failed"] as const).flatMap(
    (phase) => {
      const copy = parseEventLifecyclePhase(toolName, phase, raw[phase]);
      return copy ? ([[phase, copy]] as const) : [];
    },
  );
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
}

function parseEventLifecyclePhase(
  toolName: string,
  phase: "started" | "completed" | "failed",
  raw: unknown,
): { status: string; message: string } | undefined {
  if (raw === undefined) return undefined;
  if (!isToolDefinitionRecordValue(raw)) {
    throw invalidEventLifecyclePhase(toolName, phase);
  }
  if (typeof raw.status !== "string" || raw.status.trim().length === 0) {
    throw invalidEventLifecyclePhase(toolName, phase);
  }
  if (typeof raw.message !== "string" || raw.message.trim().length === 0) {
    throw invalidEventLifecyclePhase(toolName, phase);
  }
  return { status: raw.status.trim(), message: raw.message.trim() };
}

function invalidEventPresentation(toolName: string): Error {
  return new Error(
    `Invalid tool definition for ${toolName} (eventPresentation)`,
  );
}

function invalidEventMetadataProjection(toolName: string, key: string): Error {
  return new Error(
    `Invalid tool definition for ${toolName} (eventPresentation.metadata.${key})`,
  );
}

function invalidEventLifecyclePhase(toolName: string, phase: string): Error {
  return new Error(
    `Invalid tool definition for ${toolName} (eventPresentation.lifecycle.${phase})`,
  );
}
