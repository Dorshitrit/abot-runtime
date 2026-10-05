import { posix, win32 } from "node:path";

function logicalSeparators(value: string): string {
  return value.replaceAll("\\", "/");
}

function hasDrivePrefix(value: string): boolean {
  return /^[A-Za-z]:/u.test(value);
}

function hasQualifiedDrive(value: string): boolean {
  return /^[A-Za-z]:\//u.test(value);
}

function hasQualifiedNetworkRoot(value: string): boolean {
  if (value.startsWith("//?/") || value.startsWith("//./")) return false;
  return /^\/\/[^/]+\/[^/]+(?:\/|$)/u.test(value);
}

function hasBackslashNetworkOrDeviceRoot(value: string): boolean {
  const prefix = value.slice(0, 2);
  const networkRoot = /^[\\/]{2}$/u.test(prefix) && prefix.includes("\\");
  return networkRoot || value.startsWith("\\??\\");
}

/** A relative component cannot normalize into a foreign drive namespace. */
export function isRuntimePathNamespaceCompatible(
  value: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const logical = logicalSeparators(value);
  if (platform !== "win32" && hasBackslashNetworkOrDeviceRoot(value)) return false;
  if (hasDrivePrefix(logical)) return platform === "win32" && hasQualifiedDrive(logical);
  if (platform === "win32" && logical.startsWith("/")) return hasQualifiedNetworkRoot(logical);
  // Use the standard path grammar before checking a relative drive prefix.
  return !hasDrivePrefix(posix.normalize(logical));
}

/** Preserve a native Windows UNC root while normalizing scoped tool paths. */
export function normalizeRuntimePathForScope(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32" && win32.isAbsolute(value)) {
    return logicalSeparators(win32.normalize(value));
  }
  return posix.normalize(logicalSeparators(value));
}

/** A different Windows drive or share produces an absolute relative result. */
export function isRuntimePathWithinRoot(
  target: string,
  root: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const paths = platform === "win32" ? win32 : posix;
  const relative = paths.relative(root, target);
  if (paths.isAbsolute(relative)) return false;
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${paths.sep}`))
  );
}
