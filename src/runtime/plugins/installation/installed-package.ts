import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { parsePluginInstallSource } from "../../../plugin-contract/install-source.js";
import type { DiscoveredAgentPluginManifest } from "../discovered-manifest.js";
import { isPortablePluginPathComponent } from "./portable-path.js";

/** Stable package identity also works after moving it outside the discovery directory. */
export function installedPluginPackageIdentity(
  path: string,
): string | undefined {
  try {
    const folder = lstatSync(path);
    const receiptPath = join(path, ".abot-install.json");
    const receiptStat = lstatSync(receiptPath);
    if (
      !folder.isDirectory() ||
      !receiptStat.isFile() ||
      receiptStat.size > 4096
    )
      return undefined;
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    if (
      receipt.schemaVersion !== 1 ||
      typeof receipt.digest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(receipt.digest) ||
      typeof receipt.installedAt !== "string" ||
      !Number.isFinite(Date.parse(receipt.installedAt))
    )
      return undefined;
    const source = parsePluginInstallSource(receipt.source);
    if (!source.ref || !/^[a-f0-9]{40}$/u.test(source.ref)) return undefined;
    const manifestPath = join(path, "plugin.json");
    const manifestStat = lstatSync(manifestPath);
    if (!manifestStat.isFile()) return undefined;
    return JSON.stringify([
      folder.dev,
      folder.ino,
      folder.birthtimeMs,
      receipt,
      readFileSync(manifestPath, "utf8"),
    ]);
  } catch {
    return undefined;
  }
}

/** Only installer-owned, direct consumer folders are removable. Never follow links. */
export function installedPluginPackage(
  rootDir: string,
  plugin: DiscoveredAgentPluginManifest,
): { path: string; identity: string; packageIdentity: string } | undefined {
  const id = plugin.manifest.name;
  if (!isPortablePluginPathComponent(id)) return undefined;
  try {
    const directory = join(realpathSync(rootDir), "plugins");
    const path = join(directory, id);
    if (resolve(plugin.pluginRoot) !== path) return undefined;
    const parent = lstatSync(directory);
    if (!parent.isDirectory()) return undefined;
    const packageIdentity = installedPluginPackageIdentity(path);
    if (!packageIdentity) return undefined;
    return {
      path,
      packageIdentity,
      identity: JSON.stringify([parent.dev, parent.ino, packageIdentity]),
    };
  } catch {
    return undefined;
  }
}
