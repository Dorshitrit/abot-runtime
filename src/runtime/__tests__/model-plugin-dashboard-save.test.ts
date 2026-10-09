import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  getConfigDashboardSnapshot,
  saveConfigDashboardFile,
} from "../../web-ui/config-dashboard-backend.js";
import { loadRuntimeConfig } from "../config.js";

// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { setModelCapabilityEnabled } from "../../web-ui/app/components/config-workspace/model-plugin-selection.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("model dashboard save persists deny in its linked profile and runtime reload reads it", async () => {
  const artifacts = resolve(
    ".codex/artifacts/model-plugin-controls/dashboard-save",
  );
  await mkdir(artifacts, { recursive: true });
  const rootDir = await mkdtemp(join(artifacts, "fixture-"));
  roots.push(rootDir);
  const local = join(rootDir, "local");
  await mkdir(join(local, "models"), { recursive: true });
  const configPath = join(local, "runtime.config.json");
  const profilePath = join(local, "models", "selected.config.json");
  const profile = {
    label: "Selected model",
    provider: "local",
    model: "model:test",
    contextWindowTokens: 32768,
    generation: { temperature: 0.2 },
    execution: { policy: "execution-agent-v1" },
    plugins: { deny: ["filesystem.read_file", "missing-plugin"] },
  };
  const runtime = {
    requestRunner: { configRef: "./runner.json" },
    plugins: { enabled: true, allow: ["*"], deny: ["globally-denied"] },
    models: {
      providers: { local: { type: "ollama" } },
      profiles: {
        selected: { configRef: "./models/selected.config.json" },
        other: {
          provider: "local",
          model: "other:test",
          contextWindowTokens: 32768,
        },
      },
    },
  };
  await writeFile(configPath, JSON.stringify(runtime, null, 2));
  await writeFile(profilePath, JSON.stringify(profile, null, 2));
  await writeFile(
    join(local, "runner.json"),
    JSON.stringify({
      schemaVersion: 2,
      models: { defaults: { profileId: "selected", steps: {} } },
      context: {
        outputReserveTokens: 4096,
        safetyReserveTokens: 1200,
        attachmentReserveTokens: 1024,
      },
      stepDefaults: { timeoutMs: 90000 },
      steps: {},
    }),
  );
  const originalRuntimeBytes = await readFile(configPath, "utf8");
  const options = { rootDir, configPath };
  const snapshot = await getConfigDashboardSnapshot(options);
  const target = snapshot.files.models.find(({ id }) => id === "selected")!;
  const candidate = structuredClone(target.config);
  expect(
    setModelCapabilityEnabled(
      candidate,
      [
        {
          id: "filesystem",
          pluginEnabled: true,
          state: "enabled",
          capabilities: [{ id: "write_file", enabled: true }],
        },
      ],
      "filesystem",
      "write_file",
      false,
    ),
  ).toBe(true);
  const saved = await saveConfigDashboardFile({
    ...options,
    kind: "model",
    id: "selected",
    config: candidate,
    expectedRevision: target.revision,
  });
  expect(saved.file.revision).not.toBe(target.revision);
  expect(JSON.parse(await readFile(profilePath, "utf8"))).toEqual({
    ...profile,
    plugins: {
      deny: ["filesystem.read_file", "missing-plugin", "filesystem.write_file"],
    },
  });
  expect(await readFile(configPath, "utf8")).toBe(originalRuntimeBytes);
  const reloaded = await getConfigDashboardSnapshot(options);
  expect(
    reloaded.files.models.find(({ id }) => id === "selected")?.config,
  ).toEqual(candidate);
  const loadedRuntime = loadRuntimeConfig({ ...options, env: {} });
  expect(loadedRuntime.modelExecutionPolicies?.selected).toEqual({
    policy: "execution-agent-v1",
    plugins: {
      deny: ["filesystem.read_file", "filesystem.write_file", "missing-plugin"],
    },
  });
  expect(loadedRuntime.modelExecutionPolicies?.other).toBeUndefined();
  expect(loadedRuntime.plugins?.deny).toEqual(["globally-denied"]);
});
