/** Parse display rows only; the backend owns comparison, paths and change detection. */
export function projectDiffLines(patch) {
  const rows = [];
  let oldLine = null;
  let newLine = null;
  const lines = String(patch ?? "").split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const text of lines) {
    if (text.startsWith("diff --")) { oldLine = null; newLine = null; }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: "hunk", oldLine: null, newLine: null, text });
      continue;
    }
    if (oldLine === null || newLine === null) {
      rows.push({ kind: "meta", oldLine: null, newLine: null, text });
      continue;
    }
    if (text.startsWith("+")) {
      rows.push({ kind: "added", oldLine: null, newLine: newLine++, text });
      continue;
    }
    if (text.startsWith("-")) {
      rows.push({ kind: "deleted", oldLine: oldLine++, newLine: null, text });
      continue;
    }
    if (text.startsWith(" ")) {
      rows.push({ kind: "context", oldLine: oldLine++, newLine: newLine++, text });
      continue;
    }
    rows.push({ kind: "meta", oldLine: null, newLine: null, text });
  }
  return rows;
}
