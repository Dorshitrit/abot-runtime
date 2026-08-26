import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadRuntimeConfig } from "../config.js";
import type { RuntimeConfig } from "../ports.js";

export function loadPublicRuntimeConfig(
  pluginIds: readonly string[],
): RuntimeConfig {
  const rootDir = process.cwd();
  const fixtureDir = mkdtempSync(join(tmpdir(), "runtime-public-config-"));
  try {
    const template = JSON.parse(
      readFileSync(
        join(rootDir, "examples", "runtime.config.example.json"),
        "utf-8",
      ),
    ) as Record<string, unknown>;
    const models = template.models as {
      profiles: Record<string, Record<string, unknown>>;
    };
    models.profiles.default = {
      configRef: join(rootDir, "examples", "models", "default.config.json"),
    };
    template.requestRunner = {
      configRef: join(
        rootDir,
        "examples",
        "request-runner.config.example.json",
      ),
    };
    template.plugins = {
      enabled: true,
      allow: [...pluginIds],
      deny: [],
    };
    const configPath = join(fixtureDir, "runtime.config.json");
    writeFileSync(configPath, JSON.stringify(template), "utf-8");
    return loadRuntimeConfig({ rootDir, configPath });
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}
