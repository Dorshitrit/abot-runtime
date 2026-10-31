import { PROJECT_FILE_BYTES } from "./contracts.js";

type Edit = { kind: " " | "+" | "-"; line: string };
export type TextComparison = { status: "text"; patch: string; additions: number; deletions: number } | { status: "too_large" };
function lines(text: string): string[] { return text.match(/[^\n]*\n|[^\n]+$/gu) ?? []; }
function edits(before: string[], after: string[]): Edit[] | null {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
  const old = before.slice(prefix, before.length - suffix);
  const next = after.slice(prefix, after.length - suffix);
  const width = next.length + 1;
  if ((old.length + 1) * width > 1000000) return null;
  const table = new Uint32Array((old.length + 1) * width);
  for (let left = old.length - 1; left >= 0; left--) {
    for (let right = next.length - 1; right >= 0; right--) {
      table[left * width + right] = old[left] === next[right] ? table[(left + 1) * width + right + 1]! + 1
        : Math.max(table[(left + 1) * width + right]!, table[left * width + right + 1]!);
    }
  }
  const result: Edit[] = before.slice(0, prefix).map((line) => ({ kind: " ", line }));
  let left = 0;
  let right = 0;
  while (left < old.length || right < next.length) {
    if (left < old.length && right < next.length && old[left] === next[right]) {
      result.push({ kind: " ", line: old[left++]! }); right++;
    } else if (left < old.length && (right === next.length || table[(left + 1) * width + right]! >= table[left * width + right + 1]!)) {
      result.push({ kind: "-", line: old[left++]! });
    } else result.push({ kind: "+", line: next[right++]! });
  }
  result.push(...before.slice(before.length - suffix).map((line): Edit => ({ kind: " ", line })));
  return result;
}
function hunkRanges(changes: Edit[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (let index = 0; index < changes.length; index++) {
    if (changes[index]!.kind === " ") continue;
    const start = Math.max(0, index - 3);
    const end = Math.min(changes.length, index + 4);
    const previous = ranges.at(-1);
    if (previous && start <= previous[1]) previous[1] = end;
    else ranges.push([start, end]);
  }
  return ranges;
}
export function compareProjectText(path: string, before: string, after: string, oldMode: string | null, newMode: string | null): TextComparison {
  const oldLines = lines(before);
  const newLines = lines(after);
  if (oldLines.length + newLines.length > 20000) return { status: "too_large" };
  const changes = edits(oldLines, newLines);
  if (!changes) return { status: "too_large" };
  const oldName = JSON.stringify(`a/${path}`);
  const newName = JSON.stringify(`b/${path}`);
  const output = [`diff --git ${oldName} ${newName}`];
  if (!oldMode) output.push(`new file mode ${newMode ?? "100644"}`);
  else if (!newMode) output.push(`deleted file mode ${oldMode}`);
  else if (oldMode !== newMode) output.push(`old mode ${oldMode}`, `new mode ${newMode}`);
  if (changes.some((entry) => entry.kind !== " ")) {
    output.push(`--- ${oldMode ? oldName : "/dev/null"}`, `+++ ${newMode ? newName : "/dev/null"}`);
    const oldOffsets = [0];
    const newOffsets = [0];
    for (const entry of changes) {
      oldOffsets.push(oldOffsets.at(-1)! + Number(entry.kind !== "+"));
      newOffsets.push(newOffsets.at(-1)! + Number(entry.kind !== "-"));
    }
    for (const [start, end] of hunkRanges(changes)) {
      const oldCount = oldOffsets[end]! - oldOffsets[start]!;
      const newCount = newOffsets[end]! - newOffsets[start]!;
      output.push(`@@ -${oldOffsets[start]! + Number(oldCount > 0)},${oldCount} +${newOffsets[start]! + Number(newCount > 0)},${newCount} @@`);
      for (const entry of changes.slice(start, end)) {
        output.push(`${entry.kind}${entry.line.endsWith("\n") ? entry.line.slice(0, -1) : entry.line}`);
        if (!entry.line.endsWith("\n")) output.push("\\ No newline at end of file");
      }
    }
  }
  const patch = `${output.join("\n")}\n`;
  if (Buffer.byteLength(patch) > PROJECT_FILE_BYTES) return { status: "too_large" };
  return { status: "text", patch, additions: changes.filter((entry) => entry.kind === "+").length, deletions: changes.filter((entry) => entry.kind === "-").length };
}
