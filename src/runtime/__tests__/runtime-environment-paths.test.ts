import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEnvironmentPathsFixture } from "./support/environment-paths-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(environment?: unknown) {
  const result = await createEnvironmentPathsFixture(environment);
  cleanups.push(result.dispose);
  return result;
}

describe("resolved environment storage namespaces", () => {
  it.each(["base", "default", "env"])(
    "isolates every generated state fallback with an inherited %s root",
    async (kind) => {
      const environment = {
        paths: kind === "base" ? { runtimeDir: "state" } : {},
        profiles: { alpha: {}, beta: {} },
      };
      const current = await fixture(environment);
      const env = kind === "env" ? { LLM_RUNTIME_DIR: "overridden" } : {};
      const alpha = current.load("alpha", env);
      const beta = current.load("beta", env);
      const base = join(
        current.rootDir,
        kind === "base" ? "state" : kind === "env" ? "overridden" : ".runtime",
      );
      expect(alpha.paths.runtimeDir).not.toBe(beta.paths.runtimeDir);
      for (const config of [alpha, beta]) {
        expect(relative(base, config.paths.runtimeDir).split(sep)[0]).toBe(
          "environments",
        );
        expect(config.paths.sessionsDir).toBe(
          join(config.paths.runtimeDir, "sessions"),
        );
        expect(config.paths.attachmentsDir).toBe(
          join(config.paths.runtimeDir, "attachments"),
        );
        expect(config.paths.traceFile).toBe(
          join(config.paths.runtimeDir, "logs", "runtime-debug.jsonl"),
        );
      }
      expect(alpha.paths.sharedDir).toBe(beta.paths.sharedDir);
      expect(alpha.paths.compiledDir).toBe(beta.paths.compiledDir);
      expect(alpha.paths.workspaceDir).toBe(beta.paths.workspaceDir);
      expect(alpha.paths.agentWorkDir).toBe(beta.paths.agentWorkDir);
      await expect(readdir(base)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("uses only stable environment identity and distinguishes case and path-like IDs", async () => {
    const profiles = { alpha: {}, Alpha: {}, "../alpha": {} };
    const current = await fixture({ profiles });
    const before = current.load("alpha").paths.runtimeDir;
    current.source.modelGatewayUrl = "http://127.0.0.1:2";
    current.source.models.profiles["test-model"].model = "different-model";
    current.source.environment = { profiles: { ...profiles, later: {} } };
    await current.save();
    expect(current.load("alpha").paths.runtimeDir).toBe(before);
    const paths = Object.keys(profiles).map((id) =>
      current.load(id).paths.runtimeDir.toLowerCase(),
    );
    expect(new Set(paths).size).toBe(3);
    for (const path of paths)
      expect(path).toContain(join(".runtime", "environments") + sep);
  });

  it("preserves explicit per-profile roots and final state path overrides", async () => {
    const current = await fixture({
      paths: { runtimeDir: "base", sharedDir: "shared-state" },
      profiles: {
        alpha: {
          paths: {
            runtimeDir: "alpha-state",
            sessionsDir: "saved-sessions",
            attachmentsDir: "saved-attachments",
            traceFile: "saved.log",
          },
        },
        beta: { paths: { runtimeDir: "beta-state" } },
      },
    });
    const alpha = current.load("alpha");
    expect(alpha.paths.runtimeDir).toBe(join(current.rootDir, "alpha-state"));
    expect(alpha.paths.sessionsDir).toBe(
      join(current.rootDir, "saved-sessions"),
    );
    expect(alpha.paths.attachmentsDir).toBe(
      join(current.rootDir, "saved-attachments"),
    );
    expect(alpha.paths.traceFile).toBe(join(current.rootDir, "saved.log"));
    expect(current.load("beta").paths.runtimeDir).toBe(
      join(current.rootDir, "beta-state"),
    );
    const env = current.load("alpha", {
      LLM_RUNTIME_DIR: "shared-env",
      LLM_RUNTIME_SESSIONS_DIR: "env-sessions",
    });
    expect(env.paths.runtimeDir).toContain(
      join("shared-env", "environments") + sep,
    );
    expect(env.paths.sessionsDir).toBe(join(current.rootDir, "env-sessions"));
    expect(env.paths.attachmentsDir).toBe(alpha.paths.attachmentsDir);
  });

  it("keeps a no-profile legacy root exactly unchanged", async () => {
    const current = await fixture({
      paths: { runtimeDir: "legacy", sessionsDir: "old-sessions" },
    });
    expect(current.load().paths.runtimeDir).toBe(
      join(current.rootDir, "legacy"),
    );
    expect(current.load().paths.sessionsDir).toBe(
      join(current.rootDir, "old-sessions"),
    );
    expect(
      current.load(undefined, { LLM_RUNTIME_DIR: "env-state" }).paths
        .runtimeDir,
    ).toBe(join(current.rootDir, "env-state"));
  });

  it.each([
    "scheduler",
    "sessions",
    "attachments",
    "long-term-memory",
    "plugins",
    "memory",
    "logs",
    "local-host",
  ])(
    "refuses to hide populated legacy %s before explicit ownership assignment",
    async (directory) => {
      const current = await fixture({ profiles: { alpha: {}, beta: {} } });
      const base = join(current.rootDir, ".runtime");
      const existing = join(base, directory);
      await mkdir(existing, { recursive: true });
      await writeFile(join(existing, "existing-state"), "retained");
      expect(() => current.load("alpha")).toThrow(
        "runtime_environment_storage_assignment_required",
      );
      expect(() => current.load("alpha")).toThrow(base);
      expect(await readFile(join(existing, "existing-state"), "utf8")).toBe(
        "retained",
      );
      expect(await readdir(base)).toEqual([directory]);
    },
  );

  it("allows empty legacy folders and intentionally shared generated files", async () => {
    const current = await fixture({ profiles: { alpha: {}, beta: {} } });
    const base = join(current.rootDir, ".runtime");
    await mkdir(join(base, "sessions"), { recursive: true });
    await mkdir(join(base, "shared"));
    await writeFile(join(base, "shared", "model.log"), "shared");
    await mkdir(join(base, "compiled"));
    await writeFile(join(base, "compiled", "context.json"), "{}");
    expect(current.load("alpha").paths.runtimeDir).not.toBe(
      current.load("beta").paths.runtimeDir,
    );
  });

  it("accepts explicit in-place ownership without overriding a global runtime directory", async () => {
    const current = await fixture({
      profiles: { alpha: { paths: { runtimeDir: ".runtime" } }, beta: {} },
    });
    const base = join(current.rootDir, ".runtime");
    await mkdir(join(base, "sessions"), { recursive: true });
    await writeFile(join(base, "sessions", "old.json"), "{}");
    expect(current.load("alpha").paths.runtimeDir).toBe(base);
    expect(
      relative(base, current.load("beta").paths.runtimeDir).split(sep)[0],
    ).toBe("environments");
    expect(() => current.load("beta", { LLM_RUNTIME_DIR: ".runtime" })).toThrow(
      "runtime_environment_storage_assignment_required",
    );
  });
});
