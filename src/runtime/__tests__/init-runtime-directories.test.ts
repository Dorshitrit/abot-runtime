import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadRuntimeConfig } from "../config.js";

type SetupConfig = Record<string, unknown> & {
  environment?: {
    default?: string;
    paths?: Record<string, string>;
    profiles?: Record<string, { paths?: Record<string, string> }>;
  };
  paths?: Record<string, string>;
};

const sourceRoot = resolve(import.meta.dirname, "../../..");
const temporaryRoots: string[] = [];

async function createConsumer(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "abot-init-directories-"));
  temporaryRoots.push(root);
  return root;
}

function initialize(root: string, overrides: NodeJS.ProcessEnv = {}) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("LLM_RUNTIME_"),
    ),
  );
  return spawnSync(
    process.execPath,
    [
      join(sourceRoot, "node_modules/tsx/dist/cli.mjs"),
      join(sourceRoot, "scripts/init-runtime.ts"),
      "--root",
      root,
      "--provider",
      "ollama",
      "--model",
      "init-directory-test-model",
    ],
    { cwd: root, env: { ...inherited, ...overrides }, encoding: "utf-8" },
  );
}

function configPath(root: string): string {
  return join(root, "local/runtime.config.json");
}

async function readConfig(root: string): Promise<SetupConfig> {
  return JSON.parse(await readFile(configPath(root), "utf-8")) as SetupConfig;
}

async function saveConfig(root: string, config: SetupConfig): Promise<string> {
  const content = `${JSON.stringify(config, null, 2)}\n`;
  await writeFile(configPath(root), content, "utf-8");
  return content;
}

async function expectConfiguredDirectories(root: string, profileId?: string) {
  const { paths } = loadRuntimeConfig({
    rootDir: root,
    configPath: configPath(root),
    profileId,
    env: {},
  });
  for (const directory of [
    paths.runtimeDir,
    paths.agentWorkDir,
    paths.sessionsDir,
    paths.attachmentsDir,
    paths.sharedDir,
    paths.compiledDir,
    dirname(paths.traceFile),
    join(paths.sharedDir, "logs"),
  ]) {
    expect((await stat(directory)).isDirectory(), directory).toBe(true);
  }
  return paths;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("init-runtime configured directories", () => {
  it("creates the configured work and state directories for every fresh environment", async () => {
    const root = await createConsumer();
    const result = initialize(root);
    expect(result.status, result.stderr).toBe(0);
    await expectConfiguredDirectories(root, "prod");
    await expectConfiguredDirectories(root, "dev");
    await expect(
      stat(join(root, ".runtime/prod/sandbox")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(root, "workspace"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("uses preserved custom, inherited and absolute paths without modifying existing data", async () => {
    const root = await createConsumer();
    expect(initialize(root).status).toBe(0);
    const config = await readConfig(root);
    config.environment = {
      default: "blue",
      paths: {
        runtimeDir: "custom/state",
        agentWorkDir: "custom/inherited-work",
        sharedDir: "custom/shared",
        compiledDir: "custom/compiled",
      },
      profiles: {
        blue: {},
        green: {
          paths: {
            agentWorkDir: join(root, "absolute-work"),
            runtimeDir: "custom/green-state",
          },
        },
      },
    };
    const configContent = await saveConfig(root, config);
    const oldSandbox = join(root, ".runtime/prod/sandbox");
    await mkdir(oldSandbox, { recursive: true });
    await writeFile(join(oldSandbox, "existing.txt"), "keep this artifact");
    const result = initialize(root);
    expect(result.status, result.stderr).toBe(0);
    const blue = await expectConfiguredDirectories(root, "blue");
    const green = await expectConfiguredDirectories(root, "green");
    expect(blue.agentWorkDir).toBe(join(root, "custom/inherited-work"));
    expect(green.agentWorkDir).toBe(join(root, "absolute-work"));
    expect(await readFile(configPath(root), "utf-8")).toBe(configContent);
    expect(await readFile(join(oldSandbox, "existing.txt"), "utf-8")).toBe(
      "keep this artifact",
    );
  });

  it("repairs a missing configured work directory on an idempotent rerun", async () => {
    const root = await createConsumer();
    expect(initialize(root).status).toBe(0);
    const content = await readFile(configPath(root), "utf-8");
    const work = join(root, ".runtime/prod/agent-work");
    await rm(work, { recursive: true, force: true });
    const result = initialize(root);
    expect(result.status, result.stderr).toBe(0);
    expect((await stat(work)).isDirectory()).toBe(true);
    expect(await readFile(configPath(root), "utf-8")).toBe(content);
  });

  it("retains a legacy single-environment sandbox configured as the work root", async () => {
    const root = await createConsumer();
    expect(initialize(root).status).toBe(0);
    const config = await readConfig(root);
    delete config.environment;
    config.paths = {
      runtimeDir: "legacy/state",
      agentWorkDir: "legacy/sandbox",
    };
    const content = await saveConfig(root, config);
    const result = initialize(root);
    expect(result.status, result.stderr).toBe(0);
    const paths = await expectConfiguredDirectories(root);
    expect(paths.agentWorkDir).toBe(join(root, "legacy/sandbox"));
    expect(await readFile(configPath(root), "utf-8")).toBe(content);
  });

  it("honors runtime work-directory overrides in the consumer environment", async () => {
    const root = await createConsumer();
    const work = join(root, "override-work");
    const result = initialize(root, { LLM_RUNTIME_AGENT_WORK_DIR: work });
    expect(result.status, result.stderr).toBe(0);
    expect((await stat(work)).isDirectory()).toBe(true);
    await expect(
      stat(join(root, ".runtime/prod/agent-work")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a file occupying the configured directory without replacing it", async () => {
    const root = await createConsumer();
    expect(initialize(root).status).toBe(0);
    const config = await readConfig(root);
    config.environment!.profiles!.prod!.paths!.agentWorkDir = "occupied-work";
    const content = await saveConfig(root, config);
    await writeFile(join(root, "occupied-work"), "keep existing file");
    const result = initialize(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("occupied-work");
    expect(await readFile(join(root, "occupied-work"), "utf-8")).toBe(
      "keep existing file",
    );
    expect(await readFile(configPath(root), "utf-8")).toBe(content);
  });

  it("loads work-directory overrides from the consumer dotenv file", async () => {
    const root = await createConsumer();
    expect(initialize(root).status).toBe(0);
    const envPath = join(root, ".env");
    const content = await readFile(envPath, "utf-8");
    await writeFile(
      envPath,
      `${content}\nLLM_RUNTIME_AGENT_WORK_DIR=dotenv-work\n`,
    );
    const result = initialize(root);
    expect(result.status, result.stderr).toBe(0);
    expect((await stat(join(root, "dotenv-work"))).isDirectory()).toBe(true);
  });

  it("resolves all environment storage assignments before creating new output roots", async () => {
    const root = await createConsumer();
    expect(initialize(root).status).toBe(0);
    const config = await readConfig(root);
    config.environment = {
      default: "first",
      paths: { runtimeDir: "unassigned-state" },
      profiles: {
        first: { paths: { runtimeDir: "new-state", agentWorkDir: "new-work" } },
        second: {},
      },
    };
    const content = await saveConfig(root, config);
    const existingSessions = join(root, "unassigned-state/sessions");
    await mkdir(existingSessions, { recursive: true });
    await writeFile(join(existingSessions, "keep.json"), "{}");
    const result = initialize(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "runtime_environment_storage_assignment_required",
    );
    await expect(stat(join(root, "new-state"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(root, "new-work"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(existingSessions, "keep.json"), "utf-8")).toBe(
      "{}",
    );
    expect(await readFile(configPath(root), "utf-8")).toBe(content);
  });
});
