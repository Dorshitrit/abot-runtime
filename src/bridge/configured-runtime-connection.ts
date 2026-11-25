import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import type { RuntimeConfig } from "../runtime/ports.js";
import { validateRuntimeBridgeConnection, type RuntimeBridgeConnection } from "./runtime-connection.js";

/** Explicit consumer configuration only: never discover machine-specific pairing files. */
export function resolveConfiguredRuntimeConnection(
  config: RuntimeConfig,
  targetRuntimeId: string,
  rootDir: string,
): RuntimeBridgeConnection | undefined {
  const connectionFile = process.env.AGENT_BRIDGE_CONNECTION_FILE?.trim();
  if (connectionFile) {
    const connection = readPrivateConnectionFile(resolve(rootDir, connectionFile));
    if (connection.runtimeId !== config.runtimeId) return undefined;
    return connection;
  }
  // Global credentials belong only to the selected environment, not every loaded profile.
  if (config.runtimeId !== targetRuntimeId) return undefined;
  if (!config.agentBridgeToken?.trim()) return undefined;
  return validateRuntimeBridgeConnection({
    runtimeId: config.runtimeId,
    url: config.agentBridgeUrl,
    token: config.agentBridgeToken,
  }, config.runtimeId);
}

/** Imported from an explicitly supplied private regular file; errors never include its path or content. */
export function readPrivateConnectionJson(path: string): unknown {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16_384) throw new Error();
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error();
    if (process.getuid && stat.uid !== process.getuid()) throw new Error();
    const bytes = Buffer.alloc(16_385);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length === bytes.length) throw new Error();
    return JSON.parse(bytes.toString("utf8", 0, length));
  } catch {
    throw new Error("runtime_bridge_connection_file_invalid");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readPrivateConnectionFile(path: string): RuntimeBridgeConnection {
  try {
    const value = readPrivateConnectionJson(path);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const fields = value as Record<string, unknown>;
    if (typeof fields.runtimeId !== "string" || !fields.runtimeId.trim()) throw new Error();
    return validateRuntimeBridgeConnection({
      runtimeId: fields.runtimeId,
      url: fields.agentBridgeUrl ?? fields.endpoint,
      token: fields.runtimeToken ?? fields.token,
    }, fields.runtimeId);
  } catch {
    throw new Error("runtime_bridge_connection_file_invalid");
  }
}
