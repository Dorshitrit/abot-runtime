import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import JSZip from "jszip";
import { isPortablePluginPathComponent } from "./portable-path.js";
import { Readable } from "node:stream";
import { PluginInstallError } from "../../../plugin-contract/install-source.js";

function rejectArchive(message: string): never {
  throw new PluginInstallError("plugin_archive_invalid", message);
}

function requireArchivePath(name: string): string[] {
  if (name.length > 1024 || /[\\\u0000-\u001f\u007f:]/u.test(name))
    return rejectArchive("The archive contains an unsupported path.");
  const parts = name.replace(/\/$/u, "").split("/");
  if (parts.some((part) => !part || part === "." || part === ".."))
    return rejectArchive("The archive contains an unsafe path.");
  if (!parts.every(isPortablePluginPathComponent))
    return rejectArchive("The archive contains a non-portable file name.");
  return parts;
}

async function boundedEntry(
  entry: JSZip.JSZipObject,
  remaining: number,
): Promise<Buffer> {
  const stream = new Readable().wrap(entry.nodeStream());
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > Math.min(16 * 1024 * 1024, remaining))
        return rejectArchive("The expanded plugin exceeds its size limit.");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  } finally {
    stream.destroy();
  }
}

/** Expand only regular files. Nothing from the repository is executed. */
export async function extractPluginArchive(
  archive: Buffer,
  destination: string,
  subdirectory = "",
): Promise<string> {
  if (archive.length > 25 * 1024 * 1024)
    return rejectArchive("The repository archive is too large.");
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(archive, { createFolders: false });
  } catch {
    return rejectArchive("The repository did not contain a valid ZIP archive.");
  }
  const entries = Object.values(zip.files);
  if (entries.length > 2000)
    return rejectArchive("The repository contains too many files.");
  const roots = new Set<string>();
  const seen = new Set<string>();
  const hash = createHash("sha256");
  let total = 0;
  let written = 0;
  const prefix = subdirectory ? subdirectory + "/" : "";
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name, "en"),
  )) {
    const original =
      (entry as JSZip.JSZipObject & { unsafeOriginalName?: string })
        .unsafeOriginalName ?? entry.name;
    const parts = requireArchivePath(original);
    if (original !== entry.name)
      return rejectArchive("The archive contains a rewritten path.");
    roots.add(parts[0]);
    if (roots.size !== 1)
      return rejectArchive("The archive must have one repository root.");
    const mode =
      typeof entry.unixPermissions === "number" ? entry.unixPermissions : 0;
    const kind = mode & 0o170000;
    if (kind && kind !== 0o100000 && kind !== 0o040000)
      return rejectArchive(
        "Plugin archives cannot contain links or special files.",
      );
    if (entry.dir) continue;
    if (kind === 0o040000)
      return rejectArchive("The archive has inconsistent file types.");
    const relative = parts.slice(1).join("/");
    if (!relative.startsWith(prefix)) continue;
    const target = relative.slice(prefix.length);
    if (!target)
      return rejectArchive("The plugin path must select a directory.");
    if (target.split("/").includes(".git"))
      return rejectArchive("Plugin packages cannot contain Git metadata.");
    const identity = target.toLowerCase();
    if (seen.has(identity))
      return rejectArchive("The archive contains conflicting file names.");
    seen.add(identity);
    const bytes = await boundedEntry(entry, 64 * 1024 * 1024 - total);
    total += bytes.length;
    const path = join(destination, target);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, bytes, {
      flag: "wx",
      mode: mode & 0o111 ? 0o700 : 0o600,
    });
    hash
      .update(target)
      .update("\0")
      .update(String(bytes.length))
      .update("\0")
      .update(bytes);
    written += 1;
  }
  if (!written)
    return rejectArchive("No plugin files were found in the selected folder.");
  return hash.digest("hex");
}
