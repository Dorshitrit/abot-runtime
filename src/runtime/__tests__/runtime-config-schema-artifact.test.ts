import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { RUNTIME_CONFIG_JSON_SCHEMA } from "../config.js";

describe("runtime config schema artifact", () => {
  test("matches the exported runtime config JSON schema", async () => {
    const artifact = JSON.parse(
      await readFile(
        join(process.cwd(), "runtime.config.schema.json"),
        "utf-8",
      ),
    );

    expect(artifact).toEqual(RUNTIME_CONFIG_JSON_SCHEMA);
  });

  test("is referenced from package metadata", async () => {
    const packageJson = JSON.parse(
      await readFile(join(process.cwd(), "package.json"), "utf-8"),
    );

    expect(packageJson.llmRuntime).toMatchObject({
      configSchema: "./runtime.config.schema.json",
    });
  });
});
