import { lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PluginInstallError,
  parsePluginInstallSource,
} from "../../../plugin-contract/install-source.js";
import type { ConfigFileTransaction } from "../../adapters/config-file-transaction.js";
import { inspectRuntimeConfigFileWithMeta } from "../../config/loader.js";
import { publishPluginPackage } from "./publication.js";
import { withFileLock } from "../../adapters/long-term-memory/file-lock.js";
import { preparePluginPackage, requireNewPluginIdentity } from "./package.js";
import type { PluginSourceFetcher } from "./github-download.js";

function isAbsentPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function installationDirectory(rootDir: string): Promise<string> {
  const path = join(rootDir, "plugins");
  await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new PluginInstallError(
      "plugin_destination_invalid",
      "The plugins destination must be a local directory.",
    );
  return path;
}

export async function inspectPluginPackage(
  rootDir: string,
  input: unknown,
  download?: PluginSourceFetcher,
) {
  const root = await realpath(rootDir);
  const prepared = await preparePluginPackage(
    root,
    parsePluginInstallSource(input),
    download,
  );
  try {
    return prepared.review;
  } finally {
    await rm(prepared.staging, { recursive: true, force: true });
  }
}

export async function installPluginPackage<T>(options: {
  rootDir: string;
  input: unknown;
  download?: PluginSourceFetcher;
  configPath?: string;
  saveSelection: (
    pluginId: string,
    transaction: ConfigFileTransaction,
  ) => Promise<T>;
  requireMutationIdle?: () => void;
}): Promise<{
  installed: Awaited<ReturnType<typeof inspectPluginPackage>>;
  snapshot: T;
}> {
  const input = options.input as { source?: unknown; digest?: unknown } | null;
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(input.digest)
  )
    throw new PluginInstallError(
      "plugin_review_required",
      "Review the plugin before installing it.",
    );
  const source = parsePluginInstallSource(input.source);
  if (!source.ref || !/^[a-f0-9]{40}$/u.test(source.ref))
    throw new PluginInstallError(
      "plugin_review_required",
      "Installation requires the exact reviewed commit.",
    );
  const root = await realpath(options.rootDir);
  const prepared = await preparePluginPackage(root, source, options.download);
  try {
    if (
      prepared.review.digest !== input.digest ||
      prepared.review.source.ref !== source.ref
    )
      throw new PluginInstallError(
        "plugin_review_changed",
        "The plugin changed since review. Inspect it again.",
        409,
      );
    return await withFileLock(
      join(root, ".abot-plugin-installation"),
      async () => {
        const directory = await installationDirectory(root);
        requireNewPluginIdentity(
          root,
          prepared.manifest.name,
          prepared.review.capabilities.map((capability) => capability.id),
        );
        const target = join(directory, prepared.manifest.name);
        const existing = await lstat(target).catch((error: unknown) => {
          if (isAbsentPath(error)) return undefined;
          throw error;
        });
        if (existing)
          throw new PluginInstallError(
            "plugin_already_installed",
            "The destination already exists; it will not be overwritten.",
            409,
          );
        await writeFile(
          join(prepared.staging, ".abot-install.json"),
          JSON.stringify({
            schemaVersion: 1,
            source: prepared.review.source,
            digest: prepared.review.digest,
            installedAt: new Date().toISOString(),
          }) + "\n",
          { flag: "wx", mode: 0o600 },
        );
        const snapshot = await publishPluginPackage({
          staging: prepared.staging,
          target,
          pluginId: prepared.manifest.name,
          configPath: inspectRuntimeConfigFileWithMeta(root, options.configPath)
            .path,
          requireMutationIdle: options.requireMutationIdle,
          saveSelection: options.saveSelection,
        });
        return { installed: prepared.review, snapshot };
      },
    );
  } finally {
    await rm(prepared.staging, { recursive: true, force: true });
  }
}
