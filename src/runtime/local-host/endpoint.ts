import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { LocalRuntimeEndpoint } from "./contracts.js";
import { assertPrivateRuntimeAccess } from "./private-access.js";

export function localRuntimeEndpointPath(directory: string): string {
  return join(directory, "endpoint.json");
}

export { ensurePrivateRuntimeDirectory } from "./private-directory.js";

export async function readLocalRuntimeEndpoint(
  directory: string,
): Promise<LocalRuntimeEndpoint | undefined> {
  const path = localRuntimeEndpointPath(directory);
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("local_runtime_endpoint_not_private");
    await assertPrivateRuntimeAccess(
      path,
      stat,
      "local_runtime_endpoint_not_private",
    );
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isLocalRuntimeEndpoint(value))
      throw new Error("local_runtime_invalid_endpoint");
    return value;
  } catch (error) {
    if (hasFileErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

export async function writeLocalRuntimeEndpoint(
  directory: string,
  endpoint: LocalRuntimeEndpoint,
): Promise<void> {
  const path = localRuntimeEndpointPath(directory);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(endpoint), "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function removeLocalRuntimeEndpoint(
  directory: string,
  token: string,
): Promise<void> {
  const endpoint = await readLocalRuntimeEndpoint(directory);
  if (endpoint?.token !== token) return;
  await rm(localRuntimeEndpointPath(directory), { force: true });
}

export function isLocalRuntimeProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasFileErrorCode(error, "ESRCH");
  }
}

function isLocalRuntimeEndpoint(value: unknown): value is LocalRuntimeEndpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const endpoint = value as Record<string, unknown>;
  if (endpoint.version !== 1) return false;
  if (typeof endpoint.identity !== "string" || !endpoint.identity) return false;
  if (!isPositiveInteger(endpoint.pid)) return false;
  if (!isPositiveInteger(endpoint.port) || endpoint.port > 65_535) return false;
  return (
    typeof endpoint.token === "string" && /^[a-f0-9]{64}$/.test(endpoint.token)
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function hasFileErrorCode(error: unknown, code: string): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return error.code === code;
}
