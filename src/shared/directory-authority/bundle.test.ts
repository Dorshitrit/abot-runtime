import { constants } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { expect, test } from "vitest";

test.each([false, true])(
  "executes the CommonJS bundle with keepNames=%s",
  async (keepNames) => {
    const directoryPath = await mkdtemp(
      join(tmpdir(), "abot-authority-bundle-"),
    );
    const handle = await open(
      directoryPath,
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
      const { outputFiles } = await build({
        stdin: {
          contents: `import { runDirectoryAuthorityTask } from ${JSON.stringify(entry)};
          export async function probe(location) {
            return runDirectoryAuthorityTask({ ...location, input: "héllo", task: async (text) => {
              function decorate(value) { return value + " world"; }
              return { text: decorate(text), env: process.env.NODE_OPTIONS ?? null };
            }});
          }`,
          loader: "js",
          resolveDir: directoryPath,
        },
        bundle: true,
        platform: "node",
        target: "node20",
        format: "cjs",
        keepNames,
        write: false,
      });
      const bundle = join(directoryPath, "probe.cjs");
      await writeFile(bundle, outputFiles[0].contents);
      const require = createRequire(import.meta.url);
      const { probe } = require(bundle) as {
        probe(location: {
          directoryPath: string;
          directoryFd: number;
        }): Promise<unknown>;
      };
      await expect(
        probe({ directoryPath, directoryFd: handle.fd }),
      ).resolves.toEqual({ text: "héllo world", env: null });
      delete require.cache[bundle];
    } finally {
      await handle.close();
      await rm(directoryPath, { recursive: true, force: true });
    }
  },
);
