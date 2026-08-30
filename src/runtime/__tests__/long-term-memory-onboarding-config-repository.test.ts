import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createFileLongTermMemoryOnboardingConfigRepository } from "../adapters/long-term-memory/onboarding-config-repository.js";
import type { RuntimeConfigFile } from "../config/types.js";

describe("file long-term memory onboarding config repository", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  test("rejects a stale replacement without overwriting the current config", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "abot-memory-config-"));
    directories.push(rootDir);
    const configPath = join(rootDir, "runtime.config.json");
    const initial: RuntimeConfigFile = {
      requestRunner: { configRef: "./request-runner.config.json" },
    };
    await writeFile(configPath, JSON.stringify(initial), "utf8");
    const repository = createFileLongTermMemoryOnboardingConfigRepository({
      rootDir,
    });
    const snapshot = await repository.read();
    const concurrent: RuntimeConfigFile = {
      requestRunner: { configRef: "./concurrent.config.json" },
    };
    await writeFile(configPath, JSON.stringify(concurrent), "utf8");

    await expect(
      repository.write(
        { ...snapshot.config, longTermMemory: { enabled: false } },
        snapshot.config,
      ),
    ).rejects.toThrow("long_term_memory_config_changed");
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(concurrent);
  });

  test("preserves config permissions during atomic replacement", async () => {
    if (process.platform === "win32") return;
    const rootDir = await mkdtemp(join(tmpdir(), "abot-memory-config-mode-"));
    directories.push(rootDir);
    const configPath = join(rootDir, "runtime.config.json");
    const initial: RuntimeConfigFile = {
      requestRunner: { configRef: "./request-runner.config.json" },
    };
    await writeFile(configPath, JSON.stringify(initial), "utf8");
    await chmod(configPath, 0o740);
    const repository = createFileLongTermMemoryOnboardingConfigRepository({
      rootDir,
    });
    const snapshot = await repository.read();

    await repository.write(
      { ...snapshot.config, longTermMemory: { enabled: false } },
      snapshot.config,
    );

    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      longTermMemory: { enabled: false },
    });
    expect((await stat(configPath)).mode & 0o777).toBe(0o740);
  });
});
