import { execFile } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test } from "vitest";

const execute = promisify(execFile);
const rootDir = fileURLToPath(new URL("../../../", import.meta.url));
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "abot-source-web-ui-"));
  await mkdir(join(directory, "scripts"));
  for (const path of [
    "package.json",
    "LICENSE",
    "src",
    "plugins/system/source",
    "scripts/build-host-companion.ts",
  ]) {
    await cp(join(rootDir, path), join(directory, path), { recursive: true });
  }
  await symlink(
    join(rootDir, "node_modules"),
    join(directory, "node_modules"),
    "junction",
  );
  // Exercise the real source startup script without opening a listener or model.
  await writeFile(
    join(directory, "src/web-ui/server.ts"),
    `
    import { writeFile } from "node:fs/promises";
    import { readInstallerCompanionBundle } from "./system-host-setup/companion-bundle.js";
    await writeFile("web-server-entered", "yes");
    const bundle = await readInstallerCompanionBundle();
    await writeFile("served-companion.mjs", bundle);
  `,
  );
});

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

function runSourceWebUi() {
  const npmCli = process.env.npm_execpath;
  if (!npmCli)
    throw new Error("Run source startup regressions through npm test.");
  return execute(process.execPath, [npmCli, "run", "web-ui"], {
    cwd: directory,
    timeout: 15_000,
    windowsHide: true,
  });
}

test("clean source Web UI startup builds and serves a runnable companion without a full build", async () => {
  await expect(access(join(directory, "dist"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(
    access(join(directory, "src/cli/host-companion-bundle.mjs")),
  ).rejects.toMatchObject({ code: "ENOENT" });

  await runSourceWebUi();

  const generated = await readFile(
    join(directory, "dist/src/cli/host-companion-bundle.mjs"),
  );
  expect(await readFile(join(directory, "served-companion.mjs"))).toEqual(
    generated,
  );
  const help = await execute(
    process.execPath,
    [join(directory, "served-companion.mjs"), "host", "--help"],
    {
      cwd: directory,
      timeout: 5_000,
      windowsHide: true,
    },
  );
  expect(help.stdout).toContain("abot host");
  expect(help.stderr).toBe("");
}, 30_000);

test("a companion build failure stops source startup before the Web server enters", async () => {
  await rm(join(directory, "LICENSE"));

  await expect(runSourceWebUi()).rejects.toMatchObject({ code: 1 });

  await expect(
    access(join(directory, "web-server-entered")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    access(join(directory, "dist/src/cli/host-companion-bundle.mjs")),
  ).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);
