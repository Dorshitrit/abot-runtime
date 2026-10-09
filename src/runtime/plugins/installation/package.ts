import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  PluginInstallError,
  type PluginInstallSource,
} from "../../../plugin-contract/install-source.js";
import { ABOT_RUNTIME_EXTENSION } from "../../../plugin-contract/manifest.js";
import { parseAgentPluginManifest } from "../manifest-validator.js";
import { projectManifestRuntimeContract } from "../manifest-projection.js";
import { discoverConfiguredRuntimePluginManifests } from "../configured-manifests.js";
import { extractPluginArchive } from "./archive.js";
import { isPortablePluginPathComponent } from "./portable-path.js";
import {
  downloadGitHubPlugin,
  type PluginSourceFetcher,
} from "./github-download.js";

async function requireAvailableInstallMetadataPath(
  staging: string,
): Promise<void> {
  const names = await readdir(staging);
  if (names.some((name) => name.toLowerCase() === ".abot-install.json"))
    throw new PluginInstallError(
      "plugin_package_invalid",
      "The selected plugin contains the reserved .abot-install.json path.",
    );
}

export async function preparePluginPackage(
  rootDir: string,
  source: PluginInstallSource,
  download: PluginSourceFetcher = downloadGitHubPlugin,
) {
  const downloaded = await download(source);
  if (!/^[a-f0-9]{40}$/u.test(downloaded.source.ref))
    throw new PluginInstallError(
      "plugin_revision_invalid",
      "The source must resolve to an exact commit.",
    );
  const staging = await mkdtemp(join(rootDir, ".abot-plugin-install-"));
  try {
    const digest = await extractPluginArchive(
      downloaded.archive,
      staging,
      downloaded.source.path,
    );
    await requireAvailableInstallMetadataPath(staging);
    const raw = JSON.parse(
      await readFile(join(staging, "plugin.json"), "utf8"),
    ) as Record<string, unknown>;
    const manifest = parseAgentPluginManifest(
      raw,
      typeof raw.name === "string" ? raw.name : "",
    );
    if (!isPortablePluginPathComponent(manifest.name))
      throw new PluginInstallError(
        "plugin_package_invalid",
        "The plugin ID cannot be used as a portable installation folder name.",
      );
    const extension = manifest.extensions[ABOT_RUNTIME_EXTENSION];
    if (!extension.entrypoint.endsWith(".cjs"))
      throw new PluginInstallError(
        "plugin_package_not_built",
        "This plugin must include a ready-to-run CommonJS .cjs entrypoint.",
      );
    const capabilities = Object.keys(extension.capabilities);
    projectManifestRuntimeContract(
      {
        pluginRoot: staging,
        manifestPath: join(staging, "plugin.json"),
        manifest,
      },
      capabilities,
    );
    requireNewPluginIdentity(rootDir, manifest.name, capabilities);
    return {
      staging,
      manifest,
      review: {
        source: downloaded.source,
        digest,
        id: manifest.name,
        version: manifest.version ?? "",
        description: manifest.description ?? "",
        capabilities: capabilities.map((id) => ({
          id,
          description: extension.capabilities[id].description,
          operations: Object.entries(extension.capabilities[id].operations).map(
            ([name, operation]) => ({
              name,
              effect: operation.effect,
              approval: operation.approval,
            }),
          ),
        })),
        settings: extension.settings?.defaults ?? {},
        secrets: Object.entries(extension.secrets ?? {}).map(
          ([name, secret]) => ({
            name,
            env: secret.env,
            required: secret.required,
          }),
        ),
      },
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (error instanceof PluginInstallError) throw error;
    throw new PluginInstallError(
      "plugin_package_invalid",
      "The selected folder is not a complete, valid ABot plugin. Check plugin.json, its built entrypoint and referenced skills.",
    );
  }
}

export function requireNewPluginIdentity(
  rootDir: string,
  id: string,
  capabilityIds: readonly string[],
): void {
  const installed = discoverConfiguredRuntimePluginManifests(rootDir);
  if (installed.some((plugin) => plugin.manifest.name === id))
    throw new PluginInstallError(
      "plugin_already_installed",
      "A plugin with this ID is already installed. Existing plugins are never replaced.",
      409,
    );
  const existing = new Set(
    installed.flatMap((plugin) =>
      Object.keys(
        plugin.manifest.extensions[ABOT_RUNTIME_EXTENSION].capabilities,
      ),
    ),
  );
  if (capabilityIds.some((capability) => existing.has(capability)))
    throw new PluginInstallError(
      "plugin_capability_conflict",
      "This plugin declares a capability ID already provided by another installed plugin.",
      409,
    );
}
