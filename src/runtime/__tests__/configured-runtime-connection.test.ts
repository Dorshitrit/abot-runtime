import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../ports.js";
import { resolveConfiguredRuntimeConnection } from "../../bridge/configured-runtime-connection.js";

const roots: string[] = [];
const config = (runtimeId = "personal", token: string | undefined = "fixture-token") => ({
  runtimeId, agentBridgeUrl: "wss://socket.example/agent-bridge", agentBridgeToken: token,
}) as RuntimeConfig;
function pairingFile(value: unknown) {
  const root = mkdtempSync(join(tmpdir(), "abot-connection-"));
  roots.push(root);
  const path = join(root, "connection.json");
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  vi.stubEnv("AGENT_BRIDGE_CONNECTION_FILE", "connection.json");
  return { root, path };
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("configured outbound Socket connection", () => {
  it("uses configured URL and credentials only for the selected environment", () => {
    vi.stubEnv("AGENT_BRIDGE_CONNECTION_FILE", "");
    expect(resolveConfiguredRuntimeConnection(config(), "personal", "/unused")).toEqual({
      runtimeId: "personal", url: "wss://socket.example/agent-bridge", token: "fixture-token",
    });
    expect(resolveConfiguredRuntimeConnection(config("other"), "personal", "/unused")).toBeUndefined();
    expect(resolveConfiguredRuntimeConnection(config("personal", ""), "personal", "/unused")).toBeUndefined();
  });

  it.each([
    { runtimeId: "personal", agentBridgeUrl: "wss://socket.example/agent-bridge", runtimeToken: "private-token" },
    { runtimeId: "personal", endpoint: "wss://socket.example/agent-bridge", token: "private-token", status: "paired" },
  ])("binds an explicitly supplied connection file to its runtime identity", (value) => {
    const { root } = pairingFile(value);
    expect(resolveConfiguredRuntimeConnection(config(), "other", root)).toEqual({
      runtimeId: "personal", url: "wss://socket.example/agent-bridge", token: "private-token",
    });
    expect(resolveConfiguredRuntimeConnection(config("other"), "other", root)).toBeUndefined();
  });

  it("rejects malformed or missing explicit files without falling back or disclosing input", () => {
    const { root, path } = pairingFile({ runtimeId: "personal", runtimeToken: "SECRET" });
    expect(() => resolveConfiguredRuntimeConnection(config(), "personal", root))
      .toThrow("runtime_bridge_connection_file_invalid");
    writeFileSync(path, "SECRET invalid JSON");
    expect(() => resolveConfiguredRuntimeConnection(config(), "personal", root))
      .toThrow(/^runtime_bridge_connection_file_invalid$/);
    rmSync(path);
    expect(() => resolveConfiguredRuntimeConnection(config(), "personal", root))
      .toThrow(/^runtime_bridge_connection_file_invalid$/);
  });

  it.skipIf(process.platform === "win32")("rejects public-readable files and symbolic links", () => {
    const { root, path } = pairingFile({ runtimeId: "personal", endpoint: "wss://socket.example", token: "private" });
    chmodSync(path, 0o644);
    expect(() => resolveConfiguredRuntimeConnection(config(), "personal", root))
      .toThrow("runtime_bridge_connection_file_invalid");
    chmodSync(path, 0o600);
    const link = join(root, "linked.json");
    symlinkSync(path, link);
    vi.stubEnv("AGENT_BRIDGE_CONNECTION_FILE", link);
    expect(() => resolveConfiguredRuntimeConnection(config(), "personal", root))
      .toThrow("runtime_bridge_connection_file_invalid");
  });
});
