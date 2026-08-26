import { fail } from "./errors.js";

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
    text: string;
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
    const first = input.text.indexOf(input.locator);
    if (first < 0) return null;
    if (input.text.indexOf(input.locator, first + input.locator.length) >= 0) {
      fail(
        "ambiguous_text_locator",
        "Locator matched multiple locations. Use a more specific locator or numeric range.",
      );
    }
    const locatorStart = lineAtOffset(input.text, first);
    const locatorEnd = lineAtOffset(
      input.text,
      first + Math.max(input.locator.length - 1, 0),
    );
    startLine = Math.max(1, locatorStart - input.contextLines);
    endLine = Math.min(input.lines.length, locatorEnd + input.contextLines);
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

function lineAtOffset(content: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (content.charCodeAt(index) === 10) line += 1;
  }
  return line;
}
