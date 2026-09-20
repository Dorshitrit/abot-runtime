import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

async function companionLicenseNotice(rootDir: string): Promise<string> {
  const resolvePackage = createRequire(resolve(rootDir, "package.json"));
  const wsRoot = dirname(resolvePackage.resolve("ws/package.json"));
  const licenses = await Promise.all([
    readFile(resolve(rootDir, "LICENSE"), "utf8"),
    readFile(resolve(wsRoot, "LICENSE"), "utf8"),
  ]);
  if (licenses.some((license) => license.includes("*/")))
    throw new Error(
      "A companion license cannot be preserved as a block comment.",
    );
  return [
    "/*",
    "ABot Runtime license:",
    licenses[0],
    "Bundled ws license:",
    licenses[1],
    "*/",
  ].join("\n");
}

/** Produce the same native companion for every OS, with no npm runtime dependencies. */
export async function buildHostCompanionBundle(
  options: Readonly<{ rootDir?: string; outputPath?: string }> = {},
): Promise<
  Readonly<{ outputPath: string; bytes: number; inputPaths: string[] }>
> {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const outputPath = resolve(
    options.outputPath ??
      resolve(rootDir, "dist/src/cli/host-companion-bundle.mjs"),
  );
  const result = await build({
    absWorkingDir: rootDir,
    entryPoints: ["src/cli/host-companion-entry.ts"],
    outfile: outputPath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    charset: "utf8",
    legalComments: "eof",
    sourcemap: false,
    metafile: true,
    treeShaking: true,
    minifySyntax: true,
    write: false,
    logLevel: "silent",
    define: {
      "process.env.WS_NO_BUFFER_UTIL": "'1'",
      "process.env.WS_NO_UTF_8_VALIDATE": "'1'",
    },
    banner: {
      js: [
        "// Generated native companion. Install the bundle from the matching Runtime.",
        'import { createRequire as createHostRequire } from "node:module";',
        "const require = createHostRequire(import.meta.url);",
      ].join("\n"),
    },
    footer: { js: await companionLicenseNotice(rootDir) },
  });
  const imports = Object.values(result.metafile!.outputs).flatMap(
    (output) => output.imports,
  );
  const externalPackage = imports.find(
    (entry) => entry.external && !isBuiltin(entry.path),
  );
  if (externalPackage)
    throw new Error(
      `Native companion has an external dependency: ${externalPackage.path}`,
    );
  const output = result.outputFiles?.find(
    (file) => resolve(file.path) === outputPath,
  );
  if (!output) throw new Error("Native companion bundle was not produced.");
  await mkdir(dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, output.contents, { flag: "wx" });
    await rename(temporary, outputPath);
  } finally {
    await rm(temporary, { force: true });
  }
  return {
    outputPath,
    bytes: output.contents.length,
    inputPaths: Object.keys(result.metafile!.inputs),
  };
}

const isBuildHostCompanionEntry =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isBuildHostCompanionEntry) {
  const companion = await buildHostCompanionBundle();
  console.log(`built standalone host companion (${companion.bytes} bytes)`);
}
