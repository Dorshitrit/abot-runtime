import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createBrokerLocation,
  publishBrokerLocation,
  readBrokerLocation,
} from "../../computer-access/companion/broker-location.js";

let rootDir: string;
const socketDirectories = new Set<string>();

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "abot-broker-platform-"));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const directory of socketDirectories)
    await rm(directory, { recursive: true, force: true });
  socketDirectories.clear();
  await rm(rootDir, { recursive: true, force: true });
});

function usePlatform(platform: NodeJS.Platform): void {
  vi.stubGlobal("process", { ...process, platform });
}

function location(root = rootDir) {
  const result = createBrokerLocation(root);
  socketDirectories.add(dirname(result.socketPath));
  return result;
}

describe.skipIf(process.platform === "win32")("companion broker platform paths", () => {
  test("Linux keeps its existing temporary-directory address", async () => {
    usePlatform("linux");
    const key = createHash("sha256")
      .update(await realpath(rootDir))
      .digest("hex")
      .slice(0, 20);
    const receipt = location();
    expect(receipt.socketPath).toBe(
      join(tmpdir(), `abot-host-${process.getuid!()}-${key}`, "broker.sock"),
    );
    publishBrokerLocation(rootDir, receipt);
    expect(readBrokerLocation(rootDir)).toEqual(receipt);
  });

  test("macOS uses a short stable address despite long paths and different temporary environments", async () => {
    usePlatform("darwin");
    const project = join(rootDir, "long-project-".repeat(15));
    await mkdir(project);
    vi.stubEnv("TMPDIR", join(rootDir, "long-mac-temporary-directory-".repeat(5)));
    const receipt = location(project);
    expect(Buffer.byteLength(receipt.socketPath)).toBeLessThanOrEqual(103);
    publishBrokerLocation(project, receipt);
    vi.stubEnv("TMPDIR", "/different-launch-environment");
    expect(readBrokerLocation(project)).toEqual(receipt);
    const alias = join(rootDir, "project-link");
    await symlink(project, alias);
    expect(readBrokerLocation(alias)).toEqual(receipt);
  });

  test("macOS keeps separate installations isolated", async () => {
    usePlatform("darwin");
    const other = join(rootDir, "other-installation");
    await mkdir(other);
    expect(location(other).socketPath).not.toBe(location().socketPath);
  });

  test("macOS rejects a shared or symlinked socket directory", async () => {
    usePlatform("darwin");
    const directory = dirname(location().socketPath);
    await chmod(directory, 0o755);
    expect(() => location()).toThrow("host_state_directory_not_private");
    await rm(directory, { recursive: true });
    await symlink(rootDir, directory);
    expect(() => location()).toThrow("host_state_directory_invalid");
  });

  test("unsupported runtimes remain rejected", () => {
    usePlatform("freebsd");
    expect(() => location()).toThrow("host_broker_requires_linux_runtime");
  });
});
