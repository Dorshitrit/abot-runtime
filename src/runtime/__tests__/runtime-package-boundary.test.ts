import { access, readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const SUPPORTED_NODE_RANGE = "^20.19.0 || >=22.12.0";

describe("runtime package boundary", () => {
  test("publishes the runtime entrypoint instead of the local server entrypoint", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf-8"));
    const packageLock = JSON.parse(
      await readFile("package-lock.json", "utf-8"),
    );
    const isPublicSnapshot = await access("PUBLIC-SNAPSHOT.json").then(
      () => true,
      () => false,
    );

    expect(packageJson.private).toBe(!isPublicSnapshot);
    expect(packageJson.dependencies?.["@types/ws"]).toEqual(expect.any(String));
    expect(packageJson.devDependencies).not.toHaveProperty("@types/ws");
    expect(packageJson.engines?.node).toBe(SUPPORTED_NODE_RANGE);
    expect(packageLock.packages?.[""]?.engines?.node).toBe(
      SUPPORTED_NODE_RANGE,
    );
    expect(packageJson.bin).toEqual({
      abot: "./dist/src/cli/bin.js",
    });
    expect(packageLock.packages?.[""]?.bin).toEqual({
      abot: "dist/src/cli/bin.js",
    });
    expect(packageJson.main).toBe("./dist/src/runtime/index.js");
    expect(packageJson.types).toBe("./dist/src/runtime/index.d.ts");
    expect(packageJson.exports).toMatchObject({
      ".": {
        types: "./dist/src/runtime/index.d.ts",
        import: "./dist/src/runtime/index.js",
      },
      "./runtime": {
        types: "./dist/src/runtime/index.d.ts",
        import: "./dist/src/runtime/index.js",
      },
      "./runtime/adapters": {
        types: "./dist/src/runtime/adapters/index.d.ts",
        import: "./dist/src/runtime/adapters/index.js",
      },
      "./runtime/composition": {
        types: "./dist/src/runtime/composition.d.ts",
        import: "./dist/src/runtime/composition.js",
      },
      "./runtime/config": {
        types: "./dist/src/runtime/config.d.ts",
        import: "./dist/src/runtime/config.js",
      },
      "./runtime/default-adapters": {
        types: "./dist/src/runtime/default-adapters.d.ts",
        import: "./dist/src/runtime/default-adapters.js",
      },
      "./runtime/ports": {
        types: "./dist/src/runtime/ports.d.ts",
        import: "./dist/src/runtime/ports.js",
      },
      "./model-gateway": {
        types: "./dist/src/model-gateway/index.d.ts",
        import: "./dist/src/model-gateway/index.js",
      },
      "./plugin-sdk": {
        types: "./dist/src/plugin-sdk/index.d.ts",
        import: "./dist/src/plugin-sdk/index.js",
      },
      "./runtime.config.schema.json": "./runtime.config.schema.json",
    });
    expect(Object.keys(packageJson.exports)).not.toContain(
      "./runtime/orchestration/request-orchestrator",
    );
    expect(Object.keys(packageJson.exports)).not.toContain(
      "./runtime/model/model-step-runner",
    );
    expect(Object.keys(packageJson.exports)).not.toContain(
      "./runtime/policy/routing-validation",
    );
    expect(Object.keys(packageJson.exports)).not.toContain("./plugin");
    expect(packageJson.files).toEqual(
      expect.arrayContaining([
        "dist/src/runtime/",
        "dist/src/bridge/",
        "dist/src/sessions/",
        "dist/src/shared/",
        "dist/src/capabilities/",
        "dist/src/workspace/",
        "dist/src/model-gateway/",
        "dist/src/plugin-contract/",
        "dist/src/plugin-sdk/",
        "dist/src/cli/",
        "dist/src/web-ui/",
        "dist/scripts/",
        "runtime.config.schema.json",
        "docs/architecture.md",
        "docs/bridge-compatibility.md",
        "docs/known-limitations.md",
        "docs/runtime-library.md",
        "docs/runtime-public-contracts.md",
        "docs/tool-execution-result-evidence-contract.md",
        "docs/runtime-prompt-policy-contracts.md",
        "docs/runtime-invariant-coverage.md",
        "examples/minimal-runtime-composition.ts",
        "examples/runtime-library-host.ts",
        "examples/runtime.config.example.json",
        "examples/env.example",
      ]),
    );
    expect(packageJson.files).not.toContain("runtime.config.json");
    expect(packageJson.files).not.toContain("local/runtime.config.json");
    expect(packageJson.files).not.toContain("dist/src/tools-extensions/");
    expect(packageJson.files).not.toContain("dist/");
    expect(packageJson.scripts.build).toBe(
      "npm run check:model-step-registry && npm run build-config-schema && npm run typecheck:plugins && npm run build:plugins && npm run clean-dist && tsc -p tsconfig.build.json && npm run copy-build-assets",
    );
    expect(packageJson.scripts["clean-dist"]).toBe("tsx scripts/clean-dist.ts");
    expect(packageJson.scripts["copy-build-assets"]).toBe(
      "tsx scripts/copy-build-assets.ts",
    );
    expect(packageJson.scripts["smoke:runtime-package"]).toBe(
      "tsx scripts/smoke-runtime-package-import.ts",
    );
    expect(packageJson.scripts["smoke:packed-runtime-package"]).toBe(
      "tsx scripts/smoke-packed-runtime-package.ts",
    );
    expect(packageJson.scripts["check:runtime-package"]).toBe(
      "tsx scripts/check-runtime-package-contents.ts",
    );
  });
});
