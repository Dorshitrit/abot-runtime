import type { ToolCallAdapter, ToolCallAdapterInput } from "../../../src/plugin-sdk/index.js";
import type { FilesystemPathService } from "../../filesystem/source/path-service.js";
import { fail } from "../../filesystem/source/errors.js";
import type { CommittedRange, ObservedRange, PayloadBinding, RangeReferences } from "./range-references.js";
import { digest, readSnapshot, versionKey } from "./snapshot.js";
import { sameSourceVersion } from "./source-version.js";

export const EA_FILE_PAYLOAD_CONTRACT = "execution_file_v1";
export const MAX_AUTHORED_BYTES = 262_144;

export function createPayloadAdapter(paths: FilesystemPathService, references: RangeReferences,
  operation: "create" | "edit"): ToolCallAdapter {
  return {
    payloadContent(input) { return boundPayload(input, paths, references).body; },
    async preparePayload(input, context) {
      context.abortSignal?.throwIfAborted();
      const rangeRef = readSelectedRangeReference(operation, input.params.range_ref);
      const target = paths.resolve(input.params.path);
      const snapshot = await readSnapshot(target);
      assertOperationTargetExists(operation, snapshot.content);
      const version = versionKey(snapshot.version);
      const range = rangeRef === undefined ? undefined
        : references.resolve(rangeRef, target.absolutePath, version);
      const source = selectPayloadSource(operation, range, snapshot.content);
      const binding = references.bind({ path: target.absolutePath, version, mode: source.mode,
        ...(range ? { start: range.start, end: range.end } : {}),
      });
      return Object.freeze({
        authoringContract: EA_FILE_PAYLOAD_CONTRACT,
        context: Object.freeze({ path: target.logicalPath, ...source, maxBytes: MAX_AUTHORED_BYTES }),
        bind(body: string) {
          if (Buffer.byteLength(body) > MAX_AUTHORED_BYTES)
            fail("ea_payload_too_large", "The authored payload exceeds the file payload limit.");
          references.seal(binding.id, digest(body));
          return JSON.stringify({ binding: binding.id, body });
        },
      });
    },
    validateCall(input) {
      try { boundPayload(input, paths, references); return null; }
      catch { return { error: "ea_payload_binding_invalid" }; }
    },
    async executionBinding(input, context) {
      context.abortSignal?.throwIfAborted();
      const bound = boundPayload(input, paths, references);
      const snapshot = await readSnapshot(bound.target);
      if (!sameSourceVersion(bound.binding.version, versionKey(snapshot.version)))
        fail("filesystem_target_changed", "The target changed after payload preparation. Read it again.");
      return { identity: bound.identity, metadata: {
        path: bound.target.logicalPath, operation: bound.binding.mode === "create" ? "create" : "edit",
      } };
    },
  };
}

function readSelectedRangeReference(operation: "create" | "edit", value: unknown): string | undefined {
  if (operation === "create") return undefined;
  if (typeof value !== "string" || !value.trim())
    fail("ea_range_required", "edit_text requires a range_ref from read_text or a successful edit_text for this file.");
  return value;
}

function assertOperationTargetExists(operation: "create" | "edit", content: string | null): void {
  if (operation === "create" && content === null) return;
  if (operation === "edit" && content !== null) return;
  if (operation === "create")
    fail("ea_file_exists", "create_text only creates a new file; use edit_text for an existing file.");
  fail("file_not_found", "edit_text requires an existing file.");
}

/** Only an explicitly selected range adds source text to authoring context. */
function selectPayloadSource(operation: "create" | "edit", range: ObservedRange | CommittedRange | undefined, content: string | null):
  Readonly<{ mode: "create" | "range"; sourceText?: string }> {
  if (operation === "create") return { mode: "create" };
  if (!range) return fail("ea_range_required", "edit_text requires a selected source range.");
  if ("text" in range) return { mode: "range", sourceText: range.text };
  if (content === null || range.end > content.length)
    return fail("ea_range_invalid", "The committed range is not available in the current file.");
  if (!isCompleteTextBoundary(content, range.start) || !isCompleteTextBoundary(content, range.end))
    return fail("ea_range_invalid", "The committed range does not preserve complete UTF-8 characters.");
  const sourceText = content.slice(range.start, range.end);
  if (Buffer.byteLength(sourceText) > MAX_AUTHORED_BYTES)
    return fail("ea_range_invalid", "The committed range exceeds the replacement byte limit.");
  return { mode: "range", sourceText };
}

function isCompleteTextBoundary(content: string, offset: number): boolean {
  const code = content.charCodeAt(offset);
  return !(code >= 0xdc00 && code <= 0xdfff);
}

export function boundPayload(input: ToolCallAdapterInput, paths: FilesystemPathService, references: RangeReferences) {
  const target = paths.resolve(input.params.path);
  if (!hasBoundedFileEnvelope(input.params.payload))
    fail("ea_payload_binding_invalid", "Expected a bounded host-bound payload.");
  let value: unknown;
  try { value = JSON.parse(String(input.params.payload)); }
  catch { fail("ea_payload_binding_invalid", "Expected a host-bound payload."); }
  if (!isPreparedFileEnvelope(value)) fail("ea_payload_binding_invalid", "Expected a host-bound payload.");
  const binding = references.payload(value.binding);
  if (!matchesPreparedFileBinding(binding, target.absolutePath, input.tool, value.body))
    fail("ea_payload_binding_invalid", "The payload does not match its captured source and operation.");
  return { target, binding, body: value.body, identity: bindingIdentity(binding) };
}

function hasBoundedFileEnvelope(payload: unknown): payload is string {
  if (typeof payload !== "string") return false;
  // JSON may escape one content byte as six bytes; reserve bounded binding metadata.
  return Buffer.byteLength(payload) <= MAX_AUTHORED_BYTES * 6 + 1024;
}

function isPreparedFileEnvelope(value: unknown): value is { binding: string; body: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).length !== 2) return false;
  if (!("binding" in value) || typeof value.binding !== "string") return false;
  return "body" in value && typeof value.body === "string";
}

function matchesPreparedFileBinding(binding: PayloadBinding, path: string, tool: string, body: string): boolean {
  if (binding.path !== path) return false;
  if (binding.bodyDigest !== digest(body)) return false;
  if (tool === "create_text") return binding.mode === "create";
  return binding.mode === "range";
}

function bindingIdentity(binding: PayloadBinding): string {
  return `ea-file:${digest(JSON.stringify(binding))}`;
}
