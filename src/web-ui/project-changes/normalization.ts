import { createHash } from "node:crypto";
import { PROJECT_IDENTITY_BYTES, ProjectChangesError } from "./contracts.js";
import type { ProjectContent } from "./file-state.js";
import { requireGitRead } from "./git-process.js";
import type { ProjectIndexEntry } from "./metadata.js";
import type { ProjectGitRepository } from "./repository.js";

const ATTRIBUTES = ["text", "eol", "crlf", "ident", "working-tree-encoding"] as const;
export type ProjectAttributes = Record<typeof ATTRIBUTES[number], string>;
export async function readProjectAttributes(repository: ProjectGitRepository, paths: string[]): Promise<Map<string, ProjectAttributes>> {
  const result = new Map<string, ProjectAttributes>();
  if (!paths.length) return result;
  const selected = new Set(paths);
  const input = Buffer.from(`${paths.join("\0")}\0`);
  const bytes = requireGitRead(await repository.git(["check-attr", "-z", "--stdin", ...ATTRIBUTES], { input }));
  const fields = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes).split("\0");
  for (let position = 0; position < fields.length - 1; position += 3) {
    const path = fields[position]!;
    const name = fields[position + 1];
    const value = fields[position + 2];
    if (!selected.has(path) || !ATTRIBUTES.includes(name as typeof ATTRIBUTES[number]) || value === undefined)
      throw new ProjectChangesError("project_changes_unavailable", "Git returned unsupported file attributes.");
    const attributes = result.get(path) ?? Object.fromEntries(ATTRIBUTES.map((attribute) => [attribute, "unspecified"])) as ProjectAttributes;
    attributes[name as typeof ATTRIBUTES[number]] = value;
    result.set(path, attributes);
  }
  if (result.size !== selected.size) throw new ProjectChangesError("project_changes_unavailable", "Git file attributes are incomplete.");
  return result;
}
type Conversion = "none" | "text" | "auto";
function textAttribute(value: string): Conversion | undefined {
  if (value === "unset") return "none";
  if (value === "set" || value === "input") return "text";
  if (value === "auto") return "auto";
  return undefined;
}
function conversionMode(attributes: ProjectAttributes, autocrlf: ProjectGitRepository["autocrlf"]): Conversion {
  const text = textAttribute(attributes.text) ?? textAttribute(attributes.crlf);
  if (text === "none") return "none";
  if (attributes.eol === "lf" || attributes.eol === "crlf") return text === "auto" ? "auto" : "text";
  return text ?? (autocrlf === "false" ? "none" : "auto");
}
function hasUnsupportedTransform(attributes: ProjectAttributes): boolean {
  const encoding = attributes["working-tree-encoding"];
  return attributes.ident === "set" || !["unspecified", "", "utf-8", "utf8"].includes(encoding.toLowerCase());
}
/** Git's automatic text heuristic: NUL, lone CR and mostly control bytes stay raw. */
function isAutomaticText(bytes: Buffer): boolean {
  let printable = 0;
  let nonprintable = 0;
  for (let index = 0; index < bytes.length; index++) {
    const value = bytes[index]!;
    if (value === 0) return false;
    if (value === 13) { if (bytes[index + 1] !== 10) return false; index++; continue; }
    if (value === 10) continue;
    if (value === 127 || (value < 32 && ![8, 9, 27, 12].includes(value))) nonprintable++;
    else printable++;
  }
  if (bytes.at(-1) === 26) nonprintable--;
  return (printable >> 7) >= nonprintable;
}
async function indexPreservesCrlf(repository: ProjectGitRepository, index: ProjectIndexEntry | undefined): Promise<boolean> {
  if (!index || index.conflict) return false;
  const bytes = requireGitRead(await repository.git(["cat-file", "blob", index.oid], { maxBytes: PROJECT_IDENTITY_BYTES }));
  return isAutomaticText(bytes) && bytes.includes(Buffer.from("\r\n"));
}
export async function normalizeProjectContent(repository: ProjectGitRepository, attributes: ProjectAttributes, content: ProjectContent, index: ProjectIndexEntry | undefined): Promise<ProjectContent> {
  if (hasUnsupportedTransform(attributes)) return { status: "unavailable" };
  if (!("text" in content) || content.text === undefined || !content.text.includes("\r\n")) return content;
  const mode = conversionMode(attributes, repository.autocrlf);
  if (mode === "none") return content;
  if (mode === "auto") {
    if (!isAutomaticText(Buffer.from(content.text))) return content;
    try { if (await indexPreservesCrlf(repository, index)) return content; }
    catch (error) {
      if (error instanceof ProjectChangesError && error.code === "project_changes_too_large") return { status: "too_large", hash: "" };
      throw error;
    }
  }
  const text = content.text.replace(/\r\n/gu, "\n");
  const bytes = Buffer.from(text);
  const hash = createHash(repository.head?.length === 64 ? "sha256" : "sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  return { status: content.status, text, hash };
}
