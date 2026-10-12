import { createRequire } from "node:module";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import createFilesystemPlugin from "../../../plugins/filesystem/source/index.js";
import type { RuntimePluginEntrypointFactory } from "../../plugin-contract/entrypoint.js";
import {
  createPortablePluginFixture,
  removePortablePluginFixtures,
} from "./windows-portable-plugins-fixture.js";

const require = createRequire(import.meta.url);
afterEach(removePortablePluginFixtures);

describe("filesystem file and directory targets", () => {
  test.each([false, true])("preserves extensionless files and explains child-path conflicts (bundle=%s)", async (bundled) => {
    const context = await createPortablePluginFixture("filesystem");
    const root = context.runtimePaths.agentWorkDir;
    await mkdir(root, { recursive: true });
    const create = bundled
      ? require(join(context.pluginRoot, "src/index.cjs")).default as RuntimePluginEntrypointFactory
      : createFilesystemPlugin;
    const plugin = create(context);
    expect(await plugin.handlers.write_file!({ path: "README", content: "Keep this file intact." })).toMatchObject({ ok: true });
    expect(await readFile(join(root, "README"), "utf8")).toBe("Keep this file intact.");

    for (const tool of ["read_file", "write_file"] as const) {
      const result = await plugin.handlers[tool]!({ path: "README/child.txt", content: "blocked" });
      expect(result).toMatchObject({ ok: false, errorCode: "not_a_directory" });
      expect(result.output).toContain("An existing file cannot contain child files.");
      expect(result.output).not.toContain(root);
    }
    expect(await readFile(join(root, "README"), "utf8")).toBe("Keep this file intact.");
    expect(await readdir(root)).toEqual(["README"]);

    expect(await plugin.handlers.write_file!({ path: "new-project/LICENSE", content: "Extensionless content." })).toMatchObject({ ok: true });
    expect(await readFile(join(root, "new-project/LICENSE"), "utf8")).toBe("Extensionless content.");
  }, 30_000);
});
