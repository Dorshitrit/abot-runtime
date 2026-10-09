import { existsSync } from "node:fs";
import { cp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { removeRuntimePlugin } from "../../web-ui/plugin-removal-service.js";
import { withConfigurationActivationSource } from "../../web-ui/local-runtime/configuration-activation-source.js";
import {
  readConfigFileSnapshot,
  withConfigFileTransaction,
} from "../adapters/config-file-transaction.js";
import { installedRemovalFixture } from "./support/plugin-removal-fixture.js";

const boundary = vi.hoisted(() => ({
  beforeMove: undefined as undefined | ((source: string) => void),
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    renameSync: (source: string, destination: string) => {
      const before = boundary.beforeMove;
      boundary.beforeMove = undefined;
      before?.(source);
      fs.renameSync(source, destination);
    },
  };
});
afterEach(() => {
  boundary.beforeMove = undefined;
});

test("a replacement at the rename boundary is preserved in staging and never deleted", async () => {
  const f = await installedRemovalFixture();
  const original = await vi.importActual<typeof import("node:fs")>("node:fs");
  const replacement = join(f.rootDir, "replacement");
  const retained = join(f.rootDir, "retained");
  await cp(f.path, replacement, { recursive: true });
  await writeFile(join(replacement, "marker"), "new external package");
  boundary.beforeMove = (source) => {
    original.renameSync(source, retained);
    original.renameSync(replacement, source);
  };
  await expect(removeRuntimePlugin(f, f.input)).rejects.toMatchObject({
    code: "plugin_changed",
    activation: { status: "ready" },
  });
  expect(existsSync(join(retained, "src/index.cjs"))).toBe(true);
  const staging = (await readdir(f.rootDir)).find((name) =>
    name.startsWith(".abot-plugin-removal-"),
  )!;
  expect(
    await readFile(
      join(f.rootDir, staging, f.input.pluginId, "marker"),
      "utf8",
    ),
  ).toBe("new external package");
});

test("receipt replacement at rename is also detected even if the folder inode stays the same", async () => {
  const f = await installedRemovalFixture();
  const original = await vi.importActual<typeof import("node:fs")>("node:fs");
  boundary.beforeMove = (source) => {
    const receipt = join(source, ".abot-install.json");
    const parsed = JSON.parse(original.readFileSync(receipt, "utf8"));
    original.writeFileSync(
      receipt,
      JSON.stringify({ ...parsed, digest: "b".repeat(64) }),
    );
  };
  await expect(removeRuntimePlugin(f, f.input)).rejects.toMatchObject({
    code: "plugin_changed",
    activation: { status: "ready" },
  });
  const staging = (await readdir(f.rootDir)).find((name) =>
    name.startsWith(".abot-plugin-removal-"),
  )!;
  expect(
    existsSync(join(f.rootDir, staging, f.input.pluginId, "src/index.cjs")),
  ).toBe(true);
});

test("a revision change before Apply cannot activate a different saved configuration", async () => {
  const f = await installedRemovalFixture();
  const activate = vi.fn(async () => ({ status: "ready" as const }));
  await expect(
    removeRuntimePlugin(
      {
        ...f,
        applyConfiguration: async (revision) => {
          expect((await readConfigFileSnapshot(f.configPath)).revision).toBe(
            revision,
          );
          await withConfigFileTransaction(f.configPath, (tx) =>
            tx.write({ ...tx.snapshot.config, webUi: { pageSize: 25 } }),
          );
          return withConfigurationActivationSource(
            f.configPath,
            activate,
            revision,
          );
        },
      },
      f.input,
    ),
  ).rejects.toMatchObject({ code: "config_changed" });
  expect(activate).not.toHaveBeenCalled();
  expect(existsSync(f.path)).toBe(true);
});

test("an unrelated save after Apply preserves readiness of the older revision without removing files", async () => {
  const f = await installedRemovalFixture();
  await expect(
    removeRuntimePlugin(
      {
        ...f,
        applyConfiguration: async (revision) => {
          await withConfigurationActivationSource(
            f.configPath,
            async () => ({ status: "ready" }),
            revision,
          );
          await withConfigFileTransaction(f.configPath, (tx) =>
            tx.write({ ...tx.snapshot.config, webUi: { pageSize: 25 } }),
          );
          return { status: "ready" };
        },
      },
      f.input,
    ),
  ).rejects.toMatchObject({
    code: "config_changed",
    activation: { status: "ready" },
  });
  expect(existsSync(f.path)).toBe(true);
  expect(f.requireInactive).not.toHaveBeenCalled();
});

test("Apply rejection never gains ready evidence", async () => {
  const f = await installedRemovalFixture();
  const failure = new Error("Apply failed");
  await expect(
    removeRuntimePlugin(
      {
        ...f,
        applyConfiguration: async () => {
          throw failure;
        },
      },
      f.input,
    ),
  ).rejects.toBe(failure);
  expect(failure).not.toHaveProperty("activation");
});

test("a loaded-owner rejection after Apply carries confirmed activation", async () => {
  const f = await installedRemovalFixture();
  await expect(
    removeRuntimePlugin(
      {
        ...f,
        requireInactive: () => {
          throw new Error("owner unavailable");
        },
      },
      f.input,
    ),
  ).rejects.toMatchObject({
    code: "plugin_removal_failed",
    activation: { status: "ready" },
  });
  expect(existsSync(f.path)).toBe(true);
});
