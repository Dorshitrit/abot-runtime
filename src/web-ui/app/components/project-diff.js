import { projectDiffLines } from "../lib/project-diff-lines.js";

/** Render bounded server comparisons as inert text on both changes surfaces. */
export function createProjectDiff({ file, documentRoot = document }) {
  function element(tag, className, text = "") {
    const node = documentRoot.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }
  if (file.status !== "text") {
    const fallback = file.status === "binary" ? "Binary file changes cannot be shown as text." : "A text diff is unavailable for this file.";
    return element("p", "conversation-file-state", file.message || fallback);
  }
  const diff = element("div", "project-diff");
  diff.dir = "ltr";
  diff.tabIndex = 0;
  diff.setAttribute("role", "region");
  diff.setAttribute("aria-label", `Current changes in ${file.path}`);
  for (const line of projectDiffLines(file.patch)) {
    const row = element("div", "project-diff-line");
    row.dataset.kind = line.kind;
    const oldNumber = element("span", "project-diff-number", line.oldLine === null ? "" : String(line.oldLine));
    const newNumber = element("span", "project-diff-number", line.newLine === null ? "" : String(line.newLine));
    oldNumber.setAttribute("aria-hidden", "true");
    newNumber.setAttribute("aria-hidden", "true");
    row.append(oldNumber, newNumber, element("code", "project-diff-text", line.text));
    diff.appendChild(row);
  }
  if (!diff.children.length) diff.appendChild(element("p", "conversation-file-state", "No text changes to display."));
  return diff;
}
