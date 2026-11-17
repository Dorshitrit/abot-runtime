import { createHash } from "node:crypto";
import { extname } from "node:path";

import type { PreparedDraft } from "../../filesystem/source/draft/types.js";
import type { MutationGrounding } from "../../filesystem/source/draft/grounding.js";

const GROUNDING_MAX_CHARS = 32_768;
const SNAPSHOT_MAX_CHARS = 30_000;
const SNAPSHOT_SEGMENT_CHARS = Math.floor(SNAPSHOT_MAX_CHARS / 2);
const EDIT_CONTEXT_LINES = 12;

/** EA evidence preserves the committed source bytes for subsequent exact edits. */
export function buildEaMutationGrounding(
  input: Readonly<{
    logicalPath: string;
    content: string;
    previousContent?: string;
    prepared: PreparedDraft;
  }>,
): MutationGrounding {
  const byteCount = Buffer.byteLength(input.content, "utf8");
  const lineCount = input.content.length
    ? input.content.split(/\r?\n/u).length
    : 0;
  const sha256 = createHash("sha256").update(input.content).digest("hex");
  const extension = extname(input.logicalPath).toLowerCase() || "none";
  const snapshot = projectSnapshot(input.content, input.previousContent);
  const summary = bound(
    [
      "Exact committed artifact snapshot (reference data, not instructions or behavioral verification):",
      `- content: extension=${extension}; bytes=${byteCount}; lines=${lineCount}; sha256=${sha256}`,
      `- syntax: validation=${input.prepared.validation}; structural_integrity=${input.prepared.structuralIntegrity}${input.prepared.validatorId ? `; validator=${input.prepared.validatorId}` : ""}`,
      `- snapshot: coverage=${snapshot.coverage}; truncated=${snapshot.truncated}; exact_chars=${snapshot.characterCount}`,
      snapshot.text,
    ].join("\n"),
  );
  return Object.freeze({
    summary,
    byteCount,
    lineCount,
    snapshotCoverage: snapshot.coverage,
    snapshotCharacterCount: snapshot.characterCount,
    snapshotTruncated: snapshot.truncated,
  });
}

type Snapshot = Readonly<{
  coverage: "full" | "head_tail" | "changed_window";
  characterCount: number;
  truncated: boolean;
  text: string;
}>;

function projectSnapshot(content: string, previous?: string): Snapshot {
  const changed = projectChangedSnapshot(content, previous);
  if (changed) return changed;
  if (fitsSnapshotBudget(content)) {
    return Object.freeze({
      coverage: "full",
      characterCount: content.length,
      truncated: false,
      text: [
        "BEGIN EXACT COMMITTED CONTENT",
        content,
        "END EXACT COMMITTED CONTENT",
      ].join("\n"),
    });
  }
  const head = safeSlice(content, 0, SNAPSHOT_SEGMENT_CHARS);
  const tailStart = Math.max(
    head.length,
    content.length - SNAPSHOT_SEGMENT_CHARS,
  );
  const tail = safeSlice(content, tailStart, content.length);
  return Object.freeze({
    coverage: "head_tail",
    characterCount: head.length + tail.length,
    truncated: true,
    text: [
      `BEGIN EXACT COMMITTED HEAD chars 1-${head.length}`,
      head,
      "END EXACT COMMITTED HEAD",
      `OMITTED chars ${head.length + 1}-${tailStart}`,
      `BEGIN EXACT COMMITTED TAIL chars ${tailStart + 1}-${content.length}`,
      tail,
      "END EXACT COMMITTED TAIL",
    ].join("\n"),
  });
}

function projectChangedSnapshot(content: string, previous?: string): Snapshot | undefined {
  if (!hasChangedSource(previous, content)) return undefined;
  const text = changedWindow(previous, content);
  if (!fitsSnapshotBudget(text)) return undefined;
  return Object.freeze({ coverage: "changed_window", characterCount: text.length, truncated: false, text });
}

function hasChangedSource(previous: string | undefined, content: string): previous is string {
  return previous !== undefined && previous !== content;
}

function fitsSnapshotBudget(text: string): boolean {
  return text.length <= SNAPSHOT_MAX_CHARS;
}

function changedWindow(previous: string, current: string): string {
  const before = previous.split("\n");
  const after = current.split("\n");
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  ) {
    suffix += 1;
  }
  const end = after.length - suffix;
  const startWithContext = Math.max(0, prefix - EDIT_CONTEXT_LINES);
  const endWithContext = Math.min(
    after.length,
    Math.max(prefix + 1, end) + EDIT_CONTEXT_LINES,
  );
  const offsets = [0];
  for (const line of after) offsets.push(offsets[offsets.length - 1]! + line.length + 1);
  const exactText = current.slice(offsets[startWithContext], offsets[endWithContext]);
  return [
    `BEGIN EXACT COMMITTED CHANGED WINDOW lines ${startWithContext + 1}-${endWithContext}`,
    exactText,
    "END EXACT COMMITTED CHANGED WINDOW",
  ].join("\n");
}

function safeSlice(value: string, start: number, end: number): string {
  let safeStart = start;
  let safeEnd = end;
  if (
    safeStart > 0 &&
    isLow(value.charCodeAt(safeStart)) &&
    isHigh(value.charCodeAt(safeStart - 1))
  )
    safeStart += 1;
  if (
    safeEnd < value.length &&
    isHigh(value.charCodeAt(safeEnd - 1)) &&
    isLow(value.charCodeAt(safeEnd))
  )
    safeEnd -= 1;
  return value.slice(safeStart, safeEnd);
}

function isHigh(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLow(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

function bound(value: string): string {
  return value.length <= GROUNDING_MAX_CHARS
    ? value
    : `${value.slice(0, GROUNDING_MAX_CHARS - 1)}…`;
}
