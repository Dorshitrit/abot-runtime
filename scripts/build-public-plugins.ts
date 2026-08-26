import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build as esbuild } from "esbuild";

import { PUBLIC_PLUGIN_IDS } from "./public-snapshot/contracts.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type BuildMode = "check" | "write";

function parseMode(args: readonly string[]): BuildMode {
  if (args.length !== 1 || !["--check", "--write"].includes(args[0] ?? "")) {
    throw new Error(
      "Usage: tsx scripts/build-public-plugins.ts --check|--write",
    );
  }
  return args[0] === "--check" ? "check" : "write";
}

async function assertFileExists(path: string, label: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(`${label} is missing: ${path}`);
  }
}

async function assertGeneratedDirectoryExact(
  outputPath: string,
  allowMissing: boolean,
): Promise<void> {
  const outputDirectory = dirname(outputPath);
  const entries = await readdir(outputDirectory, { withFileTypes: true }).catch(
    () => [],
  );
  const names = entries.map(({ name }) => name).sort();
  if (allowMissing && entries.length === 0) return;
  if (
    entries.length !== 1 ||
    names[0] !== "index.cjs" ||
    !entries[0]?.isFile()
  ) {
    throw new Error(
      `generated plugin directory must contain exactly one regular index.cjs: ${outputDirectory}; found ${names.join(", ") || "nothing"}`,
    );
  }
}

async function buildPluginBytes(params: {
  pluginId: (typeof PUBLIC_PLUGIN_IDS)[number];
  sourcePath: string;
  outputPath: string;
}): Promise<Buffer> {
  const result = await esbuild({
    absWorkingDir: repositoryRoot,
    banner: {
      js: [
        "// GENERATED FILE - DO NOT EDIT.",
        `// Source: plugins/${params.pluginId}/source/index.ts`,
        '// Run "npm run build:plugins" after editing plugin source.',
      ].join("\n"),
    },
    bundle: true,
    charset: "utf8",
    entryPoints: [params.sourcePath],
    format: "cjs",
    legalComments: "none",
    logLevel: "silent",
    outfile: params.outputPath,
    packages: "external",
    platform: "node",
    sourcemap: false,
    target: "node20",
    treeShaking: true,
    write: false,
  });
  const output = result.outputFiles?.find(
    (file) => resolve(file.path) === resolve(params.outputPath),
  );
  if (!output) {
    throw new Error(`esbuild produced no output for ${params.pluginId}`);
  }
  return Buffer.from(output.contents);
}

async function writeAtomically(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, bytes);
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
  const plugins = PUBLIC_PLUGIN_IDS.map((pluginId) => ({
    pluginId,
    sourcePath: resolve(
      repositoryRoot,
      "plugins",
      pluginId,
      "source",
      "index.ts",
    ),
    outputPath: resolve(
      repositoryRoot,
      "plugins",
      pluginId,
      "src",
      "index.cjs",
    ),
  }));
  for (const plugin of plugins) {
    await assertFileExists(
      plugin.sourcePath,
      `${plugin.pluginId} canonical source`,
    );
    if (mode === "check") {
      await assertFileExists(
        plugin.outputPath,
        `${plugin.pluginId} generated entrypoint`,
      );
    }
    await assertGeneratedDirectoryExact(plugin.outputPath, mode === "write");
  }
  const builds = await Promise.all(
    plugins.map(async (plugin) => ({
      ...plugin,
      expected: await buildPluginBytes(plugin),
    })),
  );
  const compared = await Promise.all(
    builds.map(async (plugin) => ({
      ...plugin,
      current: await readFile(plugin.outputPath).catch(() => undefined),
    })),
  );
  const stale = compared.filter(
    (plugin) => !plugin.current?.equals(plugin.expected),
  );
  if (mode === "check" && stale.length > 0) {
    throw new Error(
      `generated plugin entrypoints are stale: ${stale.map(({ pluginId }) => pluginId).join(", ")}; run npm run build:plugins`,
    );
  }
  if (mode === "write") {
    await Promise.all(
      stale.map((plugin) =>
        writeAtomically(plugin.outputPath, plugin.expected),
      ),
    );
  }
  const staleIds = new Set(stale.map(({ pluginId }) => pluginId));
  const statuses = compared.map(
    ({ pluginId }) =>
      `${pluginId}:${staleIds.has(pluginId) ? "written" : "current"}`,
  );
  console.log(`public plugin build ${mode} ok: ${statuses.join(", ")}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
