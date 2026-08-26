import {
  boundText,
  readBoundedInteger,
  readOptionalString,
  sanitizeJsonText,
  successResult,
  type RuntimePluginLoadContext,
  type ToolExecutionContext,
  type ToolImplementation,
} from "../../../src/plugin-sdk/index.js";

import {
  DEFAULT_MAX_CHARS,
  MAX_CHARS,
  MAX_DOCUMENT_BYTES,
  MAX_IDENTITY_CHARS,
  MAX_OUTPUT_CHARS,
  MAX_OUTPUT_JSON_BYTES,
  MAX_START_CHAR,
} from "./constants.js";
import { documentReaderFailure, failDocument } from "./errors.js";
import { resolvePdfParseEntrypoint } from "./pdf-worker.js";
import { readDocument } from "./reader.js";
import { resolveDocumentReference } from "./source-resolution.js";
import type { DocumentReference } from "./types.js";

type ParsedInput =
  | Readonly<{
      sourceMode: "source";
      source: string;
      startChar: number;
      maxChars: number;
    }>
  | Readonly<{
      sourceMode: "working_path";
      workingPath: string;
      startChar: number;
      maxChars: number;
    }>;

function parseSourceMode(value: unknown): "source" | "working_path" {
  if (value === undefined) return "source";
  if (value === "source" || value === "working_path") return value;
  failDocument(
    "document_source_mode_invalid",
    "Document source_mode must be source or working_path.",
  );
}

function parseInput(params: Record<string, unknown>): ParsedInput {
  const sourceMode = parseSourceMode(params.source_mode);
  const startChar = readBoundedInteger(params.start_char, {
    defaultValue: 0,
    minimum: 0,
    maximum: MAX_START_CHAR,
    name: "start_char",
  });
  const maxChars = readBoundedInteger(params.max_chars, {
    defaultValue: DEFAULT_MAX_CHARS,
    minimum: 1_000,
    maximum: MAX_CHARS,
    name: "max_chars",
  });
  if (sourceMode === "source") {
    const source = readOptionalString(params.source, {
      name: "source",
      maxLength: 4_096,
    });
    if (!source) {
      failDocument(
        "document_source_required",
        "Document reader requires an attachment id, attachment name, or configured-root path.",
      );
    }
    return Object.freeze({ sourceMode, source, startChar, maxChars });
  }
  const workingPath = readOptionalString(params.path, {
    name: "path",
    maxLength: 4_096,
  });
  if (!workingPath) {
    failDocument(
      "document_path_required",
      "Document reader requires an explicit current-execution path.",
    );
  }
  return Object.freeze({ sourceMode, workingPath, startChar, maxChars });
}

function singleLineIdentity(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
  return normalized.length > MAX_IDENTITY_CHARS
    ? `${normalized.slice(0, MAX_IDENTITY_CHARS - 1)}…`
    : normalized;
}

function identityLines(document: DocumentReference): readonly string[] {
  const displayName = singleLineIdentity(document.displayName);
  return document.kind === "attachment"
    ? [
        `Document: ${displayName}`,
        `Attachment id: ${singleLineIdentity(document.attachmentId)}`,
      ]
    : [
        `Document: ${displayName}`,
        `Path: ${singleLineIdentity(document.path.logicalPath)}`,
      ];
}

function sourceData(
  document: DocumentReference,
): Readonly<Record<string, unknown>> {
  return document.kind === "attachment"
    ? Object.freeze({
        sourceKind: "attachment",
        attachmentId: document.attachmentId,
      })
    : Object.freeze({
        sourceKind: "runtime_path",
        location: document.path.location,
        path: document.path.logicalPath,
      });
}

function eventMetadata(
  document: DocumentReference,
): Readonly<Record<string, unknown>> | undefined {
  return document.kind === "runtime_path"
    ? Object.freeze({ path: document.path.logicalPath })
    : undefined;
}

function actionTarget(document: DocumentReference): string {
  return sanitizeJsonText(
    document.kind === "attachment"
      ? `attachment:${document.attachmentId}`
      : document.path.logicalPath,
  );
}

function renderWindow(
  document: DocumentReference,
  text: string,
  startChar: number,
  endChar: number,
  totalCharacters: number,
): string {
  const truncated = endChar < totalCharacters;
  return [
    ...identityLines(document),
    `MIME: ${document.mimeType}`,
    `Coverage: characters ${startChar}-${endChar} of ${totalCharacters}${truncated ? " (partial)" : " (complete)"}`,
    ...(truncated ? [`Next start_char: ${endChar}`] : []),
    "Content:",
    sanitizeJsonText(text.slice(startChar, endChar)) || "[no extractable text]",
  ].join("\n");
}

function selectBoundedWindow(
  document: DocumentReference,
  text: string,
  startChar: number,
  requestedEndChar: number,
  totalCharacters: number,
): Readonly<{ endChar: number; rendered: string }> {
  let lower = startChar;
  let upper = requestedEndChar;
  let endChar = startChar;
  let rendered = renderWindow(
    document,
    text,
    startChar,
    startChar,
    totalCharacters,
  );
  while (lower <= upper) {
    const candidateEnd = lower + Math.floor((upper - lower) / 2);
    const candidate = renderWindow(
      document,
      text,
      startChar,
      candidateEnd,
      totalCharacters,
    );
    const withinBounds =
      candidate.length <= MAX_OUTPUT_CHARS &&
      Buffer.byteLength(JSON.stringify(candidate), "utf8") <=
        MAX_OUTPUT_JSON_BYTES;
    if (withinBounds) {
      endChar = candidateEnd;
      rendered = candidate;
      lower = candidateEnd + 1;
    } else {
      upper = candidateEnd - 1;
    }
  }
  return Object.freeze({ endChar, rendered });
}

export function createDocumentReaderHandler(
  loadContext: RuntimePluginLoadContext,
): ToolImplementation {
  const pdfParseEntrypoint = resolvePdfParseEntrypoint(loadContext.path);
  return async (params, executionContext?: ToolExecutionContext) => {
    try {
      const input = parseInput(params);
      const document = resolveDocumentReference({
        ...input,
        loadContext,
        executionContext,
      });
      const read = await readDocument(
        document,
        pdfParseEntrypoint,
        executionContext?.abortSignal,
      );
      const totalCharacters = read.extracted.textBounds.totalCharacters;
      const startChar = Math.min(input.startChar, totalCharacters);
      const requestedEndChar = Math.min(
        read.extracted.text.length,
        startChar + input.maxChars,
      );
      const { endChar, rendered } = selectBoundedWindow(
        document,
        read.extracted.text,
        startChar,
        requestedEndChar,
        totalCharacters,
      );
      const content = read.extracted.text.slice(startChar, endChar);
      const truncated = endChar < totalCharacters;
      const output = boundText(rendered, {
        maxChars: MAX_OUTPUT_CHARS,
        marker: "\n[document output truncated]",
      });
      const eventMeta = eventMetadata(document);
      return successResult({
        output: output.text,
        producedNewInformation: true,
        actions: [
          {
            type: "inspect_target",
            target: actionTarget(document),
            details: "read_document",
          },
        ],
        data: {
          ...sourceData(document),
          ...(eventMeta ? { eventMeta } : {}),
          hasData: totalCharacters > 0,
          itemCount: totalCharacters > 0 ? 1 : 0,
          mimeType: document.mimeType,
          inputBytes: read.bytes,
          totalCharacters,
          startChar,
          endChar,
          truncated,
          limits: {
            maxInputBytes: MAX_DOCUMENT_BYTES,
            maxStartChar: MAX_START_CHAR,
            maxWindowChars: MAX_CHARS,
            maxOutputChars: MAX_OUTPUT_CHARS,
            maxOutputJsonBytes: MAX_OUTPUT_JSON_BYTES,
          },
          truncation: {
            extractedText: read.extracted.textBounds,
            window: {
              truncated,
              requestedStartChar: input.startChar,
              returnedStartChar: startChar,
              returnedEndChar: endChar,
              returnedCharacters: content.length,
              omittedAfterWindow: Math.max(totalCharacters - endChar, 0),
            },
            output: output.metadata,
          },
          extraction: read.extracted.format,
          observationMeta: { kind: "stable_fact", carryPolicy: "always" },
        },
      });
    } catch (error) {
      return documentReaderFailure(error);
    }
  };
}
