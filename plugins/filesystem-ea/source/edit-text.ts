import { lineAt } from "./snapshot.js";

export type TextEdit = Readonly<{ start: number; end: number; newText: string }>;

export function applyEdits(source: string, edits: readonly TextEdit[]) {
  let content = source;
  for (const edit of [...edits].reverse()) content = content.slice(0, edit.start) + edit.newText + content.slice(edit.end);
  let delta = 0;
  const ranges = edits.map((edit) => {
    const start = edit.start + delta;
    const result = { beforeStartLine: lineAt(source, edit.start),
      beforeEndLine: lineAt(source, Math.max(edit.start, edit.end - 1)),
      startLine: lineAt(content, start), endLine: lineAt(content, start + Math.max(0, edit.newText.length - 1)) };
    delta += edit.newText.length - (edit.end - edit.start);
    return result;
  });
  return { content, ranges };
}
