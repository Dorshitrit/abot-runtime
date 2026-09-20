import { isNativeLoopbackAddress } from "../../../plugins/system/source/companion/native-address.js";

export class InstallerInputError extends Error {}
export type CompanionInstallerInput = Readonly<{
  platform: "windows" | "macos";
  url: string;
  code: string;
  bundleSha256: string;
  expiresAt: string;
}>;
export type InstallerDownload = Readonly<{
  filename: string;
  mimeType: string;
  contentBase64: string;
}>;

function hasLocalInstallerHost(hostname: string): boolean {
  if (hostname === "localhost") return true;
  if (hostname.endsWith(".localhost")) return true;
  return isNativeLoopbackAddress(hostname);
}

export function validateCompanionInstaller(input: CompanionInstallerInput): CompanionInstallerInput {
  if (!["windows", "macos"].includes(input.platform)) throw new InstallerInputError("Choose Windows or macOS.");
  if (/[\x00-\x1f\x7f]/u.test(input.url)) throw new InstallerInputError("The Runtime origin must not contain control characters.");
  let url: URL;
  try { url = new URL(input.url); }
  catch { throw new InstallerInputError("The setup address is not a valid Runtime origin."); }
  if (url.protocol !== "http:") throw new InstallerInputError("Downloaded setup currently requires a local HTTP Runtime address. HTTPS setup is not supported; certificate verification is never disabled.");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new InstallerInputError("Use a Runtime origin without credentials, a path, query or fragment.");
  if (!hasLocalInstallerHost(url.hostname)) throw new InstallerInputError("Setup can connect only to a Runtime on this computer's loopback interface.");
  if (!/^[A-Za-z0-9_-]{43}$/u.test(input.code)) throw new InstallerInputError("The pairing code is invalid.");
  if (!/^[a-f0-9]{64}$/iu.test(input.bundleSha256)) throw new InstallerInputError("The companion bundle checksum is invalid.");
  if (!Number.isFinite(Date.parse(input.expiresAt))) throw new InstallerInputError("The pairing expiration is invalid.");
  return { ...input, url: url.origin, expiresAt: new Date(input.expiresAt).toISOString(), bundleSha256: input.bundleSha256.toLowerCase() };
}

export function validateWslDistribution(distribution?: string): string | undefined {
  if (distribution === undefined) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/u.test(distribution))
    throw new InstallerInputError("The WSL distribution name is invalid.");
  if (distribution.toLowerCase().startsWith("docker-desktop"))
    throw new InstallerInputError("Docker Desktop internal distributions cannot be changed by this setup.");
  return distribution;
}

export function installerMetadataBase64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function shellString(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}
