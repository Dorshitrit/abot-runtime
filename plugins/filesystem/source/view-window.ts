import type { BoundedText } from "./bounded-io.js";
import { selectViewLocatorWindow } from "./view-locator.js";

export const MAX_VIEW_LINES = 240;
export const DEFAULT_CONTEXT_LINES = 8;

export type SelectedWindow = Readonly<{
  startLine: number;
  endLine: number;
  rangeTruncated: boolean;
}>;

export function completeScannedLines(
  text: string,
  _truncated: boolean,
): string[] {
  const lines = text.split(/\r?\n/u);
  return lines.length ? lines : [""];
}

export function selectWindow(
  input: Readonly<{
    path: string;
    source: BoundedText;
    lines: readonly string[];
    startLine?: number;
    endLine?: number;
    locator?: string;
    contextLines: number;
  }>,
): SelectedWindow | null {
  let startLine = input.startLine ?? 1;
  let endLine =
    input.endLine ??
    (input.startLine ? input.startLine + MAX_VIEW_LINES - 1 : MAX_VIEW_LINES);
  if (input.locator) {
    return selectViewLocatorWindow({
      path: input.path,
      source: input.source,
      lineCount: input.lines.length,
      locator: input.locator,
      contextLines: input.contextLines,
      maxWindowLines: MAX_VIEW_LINES,
    });
  }
  if (endLine < startLine) [startLine, endLine] = [endLine, startLine];
  const rangeTruncated = endLine - startLine + 1 > MAX_VIEW_LINES;
  return Object.freeze({
    startLine,
    endLine: rangeTruncated ? startLine + MAX_VIEW_LINES - 1 : endLine,
    rangeTruncated,
  });
}

export function formatLines(
  lines: readonly string[],
  startLine: number,
  endLine: number,
): string {
  const width = String(endLine).length;
  return lines
    .slice(startLine - 1, endLine)
    .map(
      (line, index) =>
        `${String(startLine + index).padStart(width, " ")} | ${line}`,
    )
    .join("\n");
}

export function parseTrailingRange(value: string): Readonly<{
  path: string;
  startLine?: number;
  endLine?: number;
}> {
  const match = /^(.*):L?(\d+)(?:-L?(\d+))?$/iu.exec(value);
  if (!match?.[1]) return Object.freeze({ path: value });
  return Object.freeze({
    path: match[1],
    startLine: Number.parseInt(match[2]!, 10),
    endLine: Number.parseInt(match[3] ?? match[2]!, 10),
  });
}
