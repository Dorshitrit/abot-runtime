import type { BoundedText } from "./bounded-io.js";
import { fail } from "./errors.js";

const LOCATOR_CANDIDATE_LIMIT = 8;

type LocatorWindowInput = Readonly<{
  path: string;
  source: BoundedText;
  lineCount: number;
  locator: string;
  contextLines: number;
  maxWindowLines: number;
}>;

type LocatorCandidate = Readonly<{
  matchStartLine: number;
  matchEndLine: number;
  rangeTruncated: boolean;
  nextControls: Readonly<{
    path: string;
    start_line: number;
    end_line: number;
  }>;
}>;

export function selectViewLocatorWindow(input: LocatorWindowInput): Readonly<{
  startLine: number;
  endLine: number;
  rangeTruncated: boolean;
}> | null {
  const offsets = collectLocatorOffsets(input.source.text, input.locator);
  const first = offsets[0];
  if (first === undefined) return null;
  if (hasAmbiguousLocatorMatches(offsets)) {
    rejectAmbiguousLocator(input, offsets);
  }
  const candidate = createLocatorCandidate(input, first);
  return {
    startLine: candidate.nextControls.start_line,
    endLine: candidate.nextControls.end_line,
    rangeTruncated: candidate.rangeTruncated,
  };
}

function collectLocatorOffsets(text: string, locator: string): number[] {
  const offsets: number[] = [];
  let start = 0;
  for (let count = 0; count <= LOCATOR_CANDIDATE_LIMIT; count += 1) {
    const offset = text.indexOf(locator, start);
    if (offset < 0) break;
    offsets.push(offset);
    start = offset + 1;
  }
  return offsets;
}

function hasAmbiguousLocatorMatches(offsets: readonly number[]): boolean {
  return offsets.length > 1;
}

function createLocatorCandidate(
  input: LocatorWindowInput,
  offset: number,
): LocatorCandidate {
  const matchStartLine = lineAtOffset(input.source.text, offset);
  const matchEndLine = lineAtOffset(
    input.source.text,
    offset + Math.max(input.locator.length - 1, 0),
  );
  const startLine = Math.max(1, matchStartLine - input.contextLines);
  const requestedEndLine = Math.min(
    input.lineCount,
    matchEndLine + input.contextLines,
  );
  const endLine = Math.min(
    requestedEndLine,
    startLine + input.maxWindowLines - 1,
  );
  return {
    matchStartLine,
    matchEndLine,
    rangeTruncated: requestedEndLine > endLine,
    nextControls: {
      path: input.path,
      start_line: startLine,
      end_line: endLine,
    },
  };
}

function rejectAmbiguousLocator(
  input: LocatorWindowInput,
  offsets: readonly number[],
): never {
  const candidates = offsets
    .slice(0, LOCATOR_CANDIDATE_LIMIT)
    .map((offset) => createLocatorCandidate(input, offset));
  const candidatesTruncated = offsets.length > LOCATOR_CANDIDATE_LIMIT;
  const truncation = {
    candidateLimit: LOCATOR_CANDIDATE_LIMIT,
    candidatesTruncated,
    scanTruncated: input.source.truncated,
    omittedBytes: input.source.omittedBytes,
  };
  fail(
    "ambiguous_text_locator",
    [
      "Locator matched multiple locations; no file window was selected.",
      "Choose a unique literal locator or select one candidate's numeric controls with locator omitted.",
      `Path: ${input.path}`,
      ...candidates.map(
        ({ matchStartLine, matchEndLine, nextControls }) =>
          `Match lines ${matchStartLine}-${matchEndLine}: start_line=${nextControls.start_line}, end_line=${nextControls.end_line}`,
      ),
      `Candidate list truncated: ${candidatesTruncated}`,
      `Scan truncated: ${input.source.truncated}; bytes scanned: ${input.source.bytesRead}/${input.source.byteCount}`,
    ].join("\n"),
    {
      path: input.path,
      candidates,
      observedMatchCountLowerBound: offsets.length,
      truncation,
      eventMeta: {
        path: input.path,
        mode: "file",
        locatorAmbiguous: true,
        candidateCount: candidates.length,
        candidatesTruncated,
        scanTruncated: input.source.truncated,
      },
    },
  );
}

function lineAtOffset(content: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (content.charCodeAt(index) === 10) line += 1;
  }
  return line;
}
