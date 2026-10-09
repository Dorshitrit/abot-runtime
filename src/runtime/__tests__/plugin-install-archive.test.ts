import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, expect, test } from "vitest";
import { extractPluginArchive } from "../plugins/installation/archive.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function destination() {
  const base = join(
    process.cwd(),
    ".codex/artifacts/plugin-installation-20261006/archives",
  );
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "case-"));
  roots.push(root);
  return root;
}
test.each([
  "repo/../escape",
  "repo/C:/evil",
  "repo/path\\evil",
  "repo/CON",
  "repo/con.example",
  "repo/COM\u00b9",
  "repo/file?name",
  "repo/file*name",
  "repo/file.",
])("rejects unsafe archive entry %s", async (path) => {
  const zip = new JSZip();
  zip.file(path, "no");
  await expect(
    extractPluginArchive(
      await zip.generateAsync({ type: "nodebuffer" }),
      await destination(),
    ),
  ).rejects.toThrow();
});
test("rejects symbolic links and decompression bombs", async () => {
  const link = new JSZip();
  link.file("repo/link", "../outside", { unixPermissions: 0o120777 });
  await expect(
    extractPluginArchive(
      await link.generateAsync({ type: "nodebuffer", platform: "UNIX" }),
      await destination(),
    ),
  ).rejects.toThrow("links");
  const large = new JSZip();
  large.file("repo/large", Buffer.alloc(17 * 1024 * 1024));
  await expect(
    extractPluginArchive(
      await large.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
      await destination(),
    ),
  ).rejects.toThrow("size limit");
});
test("does not expand unrelated repository folders", async () => {
  const zip = new JSZip();
  zip.file("repo/elsewhere/large", "ignored");
  zip.file("repo/selected/file", "kept");
  const root = await destination();
  await extractPluginArchive(
    await zip.generateAsync({ type: "nodebuffer" }),
    root,
    "selected",
  );
  expect(await readdir(root)).toEqual(["file"]);
});
