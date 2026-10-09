import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import JSZip from "jszip";
import { COMPANION_NODE_DISTRIBUTIONS, COMPANION_NODE_VERSION } from "../src/web-ui/system-host-setup/node-distribution.js";
import { buildHostCompanionBundle } from "./build-host-companion.js";
import { createWindowsCompanionStoreManifest } from "./windows-companion-store-manifest.js";

export type WindowsStoreBuildOptions = Readonly<{
  rootDir: string;
  outputDir: string;
  nodeArchive: string;
  version: string;
  architecture: "x64" | "arm64";
}>;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Prepare an immutable Store package. No download, signing, installation or machine registration. */
export async function buildWindowsCompanionStoreLayout(options: WindowsStoreBuildOptions): Promise<void> {
  const manifest = createWindowsCompanionStoreManifest(options);
  const distribution = COMPANION_NODE_DISTRIBUTIONS[`win-${options.architecture}`];
  const archive = await readFile(options.nodeArchive);
  if (sha256(archive) !== distribution.sha256)
    throw new Error("The Node.js archive does not match the pinned Companion distribution.");
  const zip = await JSZip.loadAsync(archive);
  const archiveRoot = distribution.archive.replace(/\.zip$/u, "");
  const node = zip.file(`${archiveRoot}/node.exe`);
  const nodeLicense = zip.file(`${archiveRoot}/LICENSE`);
  if (!node || !nodeLicense) throw new Error("The verified Node.js archive is incomplete.");
  const destination = resolve(options.outputDir);
  await mkdir(dirname(destination), { recursive: true });
  const staging = await mkdtemp(join(dirname(destination), "store-layout-"));
  try {
    await writeFile(join(staging, "node.exe"), await node.async("nodebuffer"));
    await writeFile(join(staging, "Node-LICENSE.txt"), await nodeLicense.async("nodebuffer"));
    await copyFile(join(options.rootDir, "LICENSE"), join(staging, "ABot-LICENSE.txt"));
    await buildHostCompanionBundle({
      rootDir: options.rootDir,
      entryPoint: "src/cli/windows-companion-store-entry.ts",
      outputPath: join(staging, "companion.mjs"),
    });
    await mkdir(join(staging, "Assets"));
    for (const name of ["StoreLogo.png", "Square44x44Logo.png", "Square150x150Logo.png", "Companion.ico"])
      await copyFile(join(options.rootDir, "src/computer-access/companion/windows-store/assets", name), join(staging, "Assets", name));
    await writeFile(join(staging, "AppxManifest.xml"), manifest);
    // A new output directory prevents forgotten files from entering a later package.
    await rename(staging, destination);
    console.log(`Prepared Windows Store layout: ${destination} (${options.architecture}, Node ${COMPANION_NODE_VERSION})`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: {
    "output-dir": { type: "string" }, "node-archive": { type: "string" },
    version: { type: "string" }, architecture: { type: "string" },
  } });
  if (!values["output-dir"] || !values["node-archive"] || !values.version)
    throw new Error("Supply --output-dir, --node-archive and --version (four-part Store version).");
  const architecture = values.architecture ?? "x64";
  if (architecture !== "x64" && architecture !== "arm64") throw new Error("Use x64 or arm64.");
  await buildWindowsCompanionStoreLayout({
    rootDir: fileURLToPath(new URL("../", import.meta.url)),
    outputDir: values["output-dir"], nodeArchive: values["node-archive"],
    version: values.version, architecture,
  });
}
