import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, test } from "vitest";

const repositoryRoot = process.cwd();
const pluginsRoot = join(repositoryRoot, "plugins");
const capabilitySourceRoots = [
  join(repositoryRoot, "src", "capabilities"),
  join(repositoryRoot, "src", "runtime", "capabilities"),
];

function readJsonRecord(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  expect(value, label).toBeTypeOf("object");
  expect(value, label).not.toBeNull();
  expect(Array.isArray(value), label).toBe(false);
  return value as Record<string, unknown>;
}

function collectFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? collectFiles(path) : [path];
  });
}

function importedSpecifiers(source: string): string[] {
  return [
    ...source.matchAll(
      /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"']+)["']/g,
    ),
  ].map((match) => match[1] ?? "");
}

describe("plugin-first architecture", () => {
  test("removes every legacy tool, skill, and local plugin source tree", () => {
    for (const legacyPath of [
      "src/tools",
      "src/runtime/tools",
      "src/tools-extensions",
      "src/skills",
      "local/plugins",
    ]) {
      expect(existsSync(join(repositoryRoot, legacyPath)), legacyPath).toBe(
        false,
      );
    }
  });

  test("keeps every plugin self-contained and resolves capability skills locally", () => {
    const pluginDirectories = readdirSync(pluginsRoot, {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(pluginDirectories.length).toBeGreaterThan(0);

    for (const pluginName of pluginDirectories) {
      const pluginRoot = join(pluginsRoot, pluginName);
      const manifestPath = join(pluginRoot, "plugin.json");
      const entrypointPath = join(pluginRoot, "src", "index.cjs");

      expect(existsSync(manifestPath), `${pluginName}/plugin.json`).toBe(true);
      expect(existsSync(entrypointPath), `${pluginName}/src/index.cjs`).toBe(
        true,
      );

      const manifest = readJsonRecord(manifestPath);
      const extensions = asRecord(
        manifest.extensions,
        `${pluginName}.extensions`,
      );
      const runtimeExtension = asRecord(
        extensions["ai.abot.runtime"],
        `${pluginName}.extensions.ai.abot.runtime`,
      );
      const capabilities = asRecord(
        runtimeExtension.capabilities,
        `${pluginName}.capabilities`,
      );

      for (const [capabilityId, capabilityValue] of Object.entries(
        capabilities,
      )) {
        const capability = asRecord(
          capabilityValue,
          `${pluginName}.${capabilityId}`,
        );
        const operations = asRecord(
          capability.operations,
          `${pluginName}.${capabilityId}.operations`,
        );
        expect(
          Array.isArray(capability.skills),
          `${pluginName}.${capabilityId}.skills`,
        ).toBe(true);

        for (const skillId of capability.skills as unknown[]) {
          expect(skillId).toBeTypeOf("string");
          const skillPath = join(
            pluginRoot,
            "skills",
            skillId as string,
            "SKILL.md",
          );
          expect(
            existsSync(skillPath),
            relative(repositoryRoot, skillPath),
          ).toBe(true);
        }

        for (const [operationId, operationValue] of Object.entries(
          operations,
        )) {
          const operation = asRecord(
            operationValue,
            `${pluginName}.${capabilityId}.${operationId}`,
          );
          expect(operation).not.toHaveProperty("skills");
        }
      }
    }
  });

  test("keeps the generic capability engine independent from plugins", () => {
    for (const sourceRoot of capabilitySourceRoots) {
      for (const sourcePath of collectFiles(sourceRoot).filter((path) =>
        /\.(?:c|m)?(?:j|t)sx?$/.test(path),
      )) {
        const source = readFileSync(sourcePath, "utf8");
        const forbiddenImports = importedSpecifiers(source).filter(
          (specifier) =>
            specifier.replaceAll("\\", "/").split("/").includes("plugins"),
        );
        expect(forbiddenImports, relative(repositoryRoot, sourcePath)).toEqual(
          [],
        );
      }
    }
  });

  test("does not hard-code the legacy sandbox alias", () => {
    const checkedFiles = [
      ...collectFiles(pluginsRoot),
      ...capabilitySourceRoots.flatMap(collectFiles),
    ];
    const offenders = checkedFiles
      .filter((path) => readFileSync(path, "utf8").includes("sandbox/"))
      .map((path) => relative(repositoryRoot, path));

    expect(offenders).toEqual([]);
  });

  test("keeps runtime plugin configuration limited to selection policy", () => {
    const runtimeConfig = readJsonRecord(
      join(repositoryRoot, "examples", "runtime.config.example.json"),
    );
    const plugins = asRecord(runtimeConfig.plugins, "runtimeConfig.plugins");

    expect(Object.keys(plugins).sort()).toEqual(["allow", "deny", "enabled"]);
  });
});
