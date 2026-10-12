import { describe, expect, test } from "vitest";
import {
  ABOT_PLUGIN_COMPATIBILITY_EXTENSION,
  PLUGIN_RUNTIME_PLATFORMS,
} from "../../plugin-contract/platform-compatibility.js";
import { parseAgentPluginManifest } from "../plugins/manifest-validator.js";
import { resolvePluginPlatformCompatibility } from "../plugins/platform-compatibility.js";
import { communityManifest } from "./support/plugin-installation-fixture.js";

function declaredManifest(declaration: unknown) {
  const raw = communityManifest();
  return {
    ...raw,
    extensions: {
      ...raw.extensions,
      [ABOT_PLUGIN_COMPATIBILITY_EXTENSION]: declaration,
    },
  };
}

describe("versioned plugin platform declarations", () => {
  test("keeps runtime v1 and unrelated namespaces while validating compatibility", () => {
    const raw = declaredManifest({
      version: 1,
      runtimePlatforms: ["linux", "win32"],
    });
    const manifest = parseAgentPluginManifest(
      {
        ...raw,
        extensions: { ...raw.extensions, "community.example": { version: 8 } },
      },
      raw.name,
    );
    expect(manifest.extensions["ai.abot.runtime"].version).toBe(1);
    expect(manifest.extensions["community.example"]).toEqual({ version: 8 });
    const compatibility =
      manifest.extensions[ABOT_PLUGIN_COMPATIBILITY_EXTENSION]!;
    expect(compatibility).toEqual({
      version: 1,
      runtimePlatforms: ["linux", "win32"],
    });
    expect(Object.isFrozen(compatibility.runtimePlatforms)).toBe(true);
  });

  test.each([
    null,
    [],
    {},
    { version: 2, runtimePlatforms: ["linux"] },
    { version: "1", runtimePlatforms: ["linux"] },
    { version: 1, runtimePlatforms: [] },
    { version: 1, runtimePlatforms: "linux" },
    { version: 1, runtimePlatforms: ["windows"] },
    { version: 1, runtimePlatforms: ["linux", "linux"] },
    { version: 1, runtimePlatforms: ["linux", "darwin", "win32", "freebsd"] },
    { version: 1, runtimePlatforms: ["linux"], controlledComputer: "windows" },
  ])("rejects malformed or unsupported declarations: %j", (declaration) => {
    const raw = declaredManifest(declaration);
    expect(() => parseAgentPluginManifest(raw, raw.name)).toThrow(
      "extensions.ai.abot.compatibility",
    );
  });

  test("does not widen the existing runtime v1 fields", () => {
    const raw = communityManifest();
    Object.assign(raw.extensions["ai.abot.runtime"], {
      runtimePlatforms: ["linux"],
    });
    expect(() => parseAgentPluginManifest(raw, raw.name)).toThrow(
      "unknown field",
    );
  });
});

describe("plugin compatibility with the Runtime process OS", () => {
  test.each(["linux", "darwin", "freebsd"] as const)(
    "preserves undeclared legacy loading on %s",
    (runtimePlatform) => {
      const raw = communityManifest();
      const manifest = parseAgentPluginManifest(raw, raw.name);
      expect(
        resolvePluginPlatformCompatibility(manifest, runtimePlatform),
      ).toEqual({
        supported: true,
        status: "legacy",
        runtimePlatform,
      });
    },
  );

  test("an undeclared plugin is unavailable on native Windows", () => {
    const raw = communityManifest();
    const manifest = parseAgentPluginManifest(raw, raw.name);
    expect(resolvePluginPlatformCompatibility(manifest, "win32")).toMatchObject(
      {
        supported: false,
        status: "undeclared",
        runtimePlatform: "win32",
        reason: expect.any(String),
      },
    );
  });

  test.each(PLUGIN_RUNTIME_PLATFORMS)(
    "only a matching Runtime process OS satisfies %s support",
    (declaredPlatform) => {
      const raw = declaredManifest({
        version: 1,
        runtimePlatforms: [declaredPlatform],
      });
      const manifest = parseAgentPluginManifest(raw, raw.name);
      for (const runtimePlatform of PLUGIN_RUNTIME_PLATFORMS) {
        const decision = resolvePluginPlatformCompatibility(
          manifest,
          runtimePlatform,
        );
        expect(decision.supported).toBe(runtimePlatform === declaredPlatform);
        expect(decision.status).toBe(
          runtimePlatform === declaredPlatform ? "declared" : "unsupported",
        );
        expect(decision.runtimePlatforms).toEqual([declaredPlatform]);
      }
      expect(
        resolvePluginPlatformCompatibility(manifest, "freebsd"),
      ).toMatchObject({
        supported: false,
        status: "unsupported",
      });
    },
  );
});
