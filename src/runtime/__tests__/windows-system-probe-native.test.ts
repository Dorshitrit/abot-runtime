import { mkdir, mkdtemp, rm, statfs } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import createSystemProbePlugin from "../../../plugins/system-probe/source/index.js";
import { readMachineMetrics } from "../../../plugins/system-probe/source/metrics.js";
import type { RuntimePluginLoadContext } from "../../plugin-sdk/index.js";
import { createRuntimeToolPathResolver } from "../capabilities/runtime-target-path.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createFixture() {
  const artifacts = join(
    process.cwd(),
    ".codex",
    "artifacts",
    "windows-system-probe-native",
  );
  await mkdir(artifacts, { recursive: true });
  const rootDir = await mkdtemp(join(artifacts, "runtime-"));
  temporaryRoots.push(rootDir);
  const runtimePaths = {
    rootDir,
    runtimeDir: join(rootDir, ".runtime"),
    agentWorkDir: join(rootDir, "agent work"),
    workspaceDir: join(rootDir, "workspace"),
    sessionsDir: join(rootDir, ".runtime", "sessions"),
    attachmentsDir: join(rootDir, ".runtime", "attachments"),
    sharedDir: join(rootDir, ".runtime", "shared"),
    compiledDir: join(rootDir, ".runtime", "compiled"),
    traceFile: join(rootDir, ".runtime", "trace.jsonl"),
  };
  await Promise.all(
    [runtimePaths.agentWorkDir, runtimePaths.workspaceDir].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  const context = {
    id: "system-probe",
    path: join(process.cwd(), "plugins", "system-probe"),
    pluginRoot: join(process.cwd(), "plugins", "system-probe"),
    stateDir: join(runtimePaths.runtimeDir, "plugins", "system-probe"),
    rootDir,
    runtimeId: "windows-system-probe-test",
    agentBridgeUrl: "ws://127.0.0.1/unused",
    runtimePaths,
    runtimePathResolver: createRuntimeToolPathResolver(runtimePaths),
  } satisfies RuntimePluginLoadContext & { pluginRoot: string };
  return { context, plugin: createSystemProbePlugin(context) };
}

describe.runIf(process.platform === "win32")(
  "native Windows system probe",
  () => {
    test("measures the runtime filesystem through the real Windows statfs implementation", async () => {
      const { context, plugin } = await createFixture();
      const expected = await statfs(context.runtimePaths.rootDir);
      const result = await plugin.handlers.system_probe!({});
      expect(result).toMatchObject({
        ok: true,
        data: {
          diskPath: context.runtimePaths.rootDir,
          diskStatus: "available",
          disk: {
            totalBytes: Number(expected.bsize) * Number(expected.blocks),
          },
          machine: {
            platform: "win32",
            loadAverage: null,
            loadLevel: "unsupported",
          },
          observationMeta: { kind: "volatile_external", carryPolicy: "never" },
        },
      });
      expect(result.output).toContain("load_average: unsupported");
      expect(result.output).not.toContain("load_average: 0.00");
      expect(result.output).not.toContain("load_level: low");
    });

    test("retains explicit disk targets and identifies missing paths", async () => {
      const { context, plugin } = await createFixture();
      expect(
        await plugin.handlers.system_probe!({ path: "workspace" }),
      ).toMatchObject({
        ok: true,
        data: { diskPath: "workspace", diskStatus: "available" },
      });
      expect(
        await plugin.handlers.system_probe!({
          path: join(context.rootDir, "missing"),
        }),
      ).toMatchObject({
        ok: false,
        errorCode: "system_probe_path_not_found",
      });
    });

    test("returns genuine Windows memory and uptime metrics without synthetic load data", () => {
      const metrics = readMachineMetrics();
      expect(metrics).toMatchObject({
        platform: "win32",
        loadAverage: null,
        loadLevel: "unsupported",
      });
      expect(metrics.memoryTotalBytes).toBeGreaterThan(0);
      expect(metrics.memoryFreeBytes).toBeGreaterThanOrEqual(0);
      expect(metrics.memoryUsedBytes).toBe(
        metrics.memoryTotalBytes - metrics.memoryFreeBytes,
      );
      expect(metrics.uptimeSeconds).toBeGreaterThanOrEqual(0);
      expect(metrics.cpuCount).toBeGreaterThan(0);
    });
  },
);
