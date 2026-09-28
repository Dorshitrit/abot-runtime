import { execFile } from "node:child_process";
import { lstat, readFile, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  createModelSetupFixture,
  type ModelSetupFixture,
} from "./support/model-setup-fixture.js";

const execFileAsync = promisify(execFile);
let fixture: ModelSetupFixture;
beforeEach(async () => {
  fixture = await createModelSetupFixture(
    ".codex/artifacts/pr86-review-paths-20260923/special-files",
  );
});
afterEach(async () => fixture.cleanup());

test.skipIf(process.platform === "win32").each([false, true])(
  "rejects a FIFO profile before reading it and releases the Runtime lock (symlink=%s)",
  async (linked) => {
    const profilePath = join(
      dirname(fixture.configPath),
      "models/extra.config.json",
    );
    const fifoPath = linked ? join(fixture.rootDir, "user-pipe") : profilePath;
    const before = await readFile(fixture.configPath, "utf8");
    await execFileAsync("mkfifo", [fifoPath]);
    if (linked) await symlink(fifoPath, profilePath);
    const moduleUrl = pathToFileURL(
      resolve("src/web-ui/local-runtime/model-setup-service.ts"),
    ).href;
    // Keep a regressed blocking open outside the test process and bound its lifetime.
    const script = `
      import { ModelSetupService } from ${JSON.stringify(moduleUrl)};
      const service = new ModelSetupService({
        rootDir: ${JSON.stringify(fixture.rootDir)},
        getConfigPath: () => ${JSON.stringify(fixture.configPath)},
      });
      try {
        await service.add({ profileId: "extra", model: "fixture-extra", providerId: "ollama" });
        process.stdout.write(JSON.stringify({ added: true }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ error: error.message }));
      }
    `;
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { timeout: 10000 },
    );

    expect(JSON.parse(stdout)).toEqual({
      error: "Configuration path must be a regular file.",
    });
    expect(await readFile(fixture.configPath, "utf8")).toBe(before);
    expect((await lstat(fifoPath)).isFIFO()).toBe(true);
    expect((await lstat(profilePath)).isSymbolicLink()).toBe(linked);
    await expect(
      lstat(`${fixture.configPath}.config.lock`),
    ).rejects.toMatchObject({ code: "ENOENT" });
  },
  15000,
);
