import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  ConfigFileConflictError,
  readConfigFileSnapshot,
  withConfigFileTransaction,
} from "../adapters/config-file-transaction.js";

let root: string;
let configPath: string;
let child: ChildProcess | undefined;
beforeEach(async () => {
  const artifacts = resolve(
    ".codex/artifacts/pr71-review-fixes-20260908/config-transactions",
  );
  await mkdir(artifacts, { recursive: true });
  root = await mkdtemp(join(artifacts, "fixture-"));
  configPath = join(root, "runtime.config.json");
  await writeFile(configPath, '{ "original": true }\n');
});
afterEach(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await once(child, "exit");
  }
  child = undefined;
  await rm(root, { recursive: true, force: true });
});

test("independent processes and config symlinks use the same transaction lock", async () => {
  const alias = join(root, "alias.json");
  await symlink(configPath, alias);
  const moduleUrl = pathToFileURL(
    resolve("src/runtime/adapters/config-file-transaction.ts"),
  ).href;
  let exit!: Promise<unknown>;
  let stderr = "";
  await withConfigFileTransaction(configPath, async (transaction) => {
    child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import {withConfigFileTransaction} from ${JSON.stringify(moduleUrl)}; process.stdout.write("attempting"); await withConfigFileTransaction(${JSON.stringify(alias)}, async transaction => { await transaction.write({...transaction.snapshot.config, child: true}); });`,
      ],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stderr!.on("data", (chunk) => {
      stderr += String(chunk);
    });
    exit = once(child, "exit");
    await once(child.stdout!, "data");
    await transaction.write({ ...transaction.snapshot.config, parent: true });
  });
  await exit;
  expect(stderr).toBe("");
  expect(child!.exitCode).toBe(0);
  expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
    original: true,
    parent: true,
    child: true,
  });
  expect((await lstat(alias)).isSymbolicLink()).toBe(true);
});

test("the revision represents the exact read bytes and commit preserves permissions and backup bytes", async () => {
  await chmod(configPath, 0o640);
  const original = await readFile(configPath, "utf8");
  const snapshot = await readConfigFileSnapshot(configPath);
  const saved = await withConfigFileTransaction(configPath, (transaction) =>
    transaction.write(
      { original: true, saved: true },
      { expectedRevision: snapshot.revision },
    ),
  );
  expect(saved.revision).toBe(
    (await readConfigFileSnapshot(configPath)).revision,
  );
  expect(saved.revision).not.toBe(snapshot.revision);
  expect(await readFile(saved.backupPath!, "utf8")).toBe(original);
  expect((await stat(configPath)).mode & 0o777).toBe(0o640);
  expect((await stat(saved.backupPath!)).mode & 0o777).toBe(0o640);
});

test("even a formatting-only external edit invalidates an old browser revision", async () => {
  const snapshot = await readConfigFileSnapshot(configPath);
  await writeFile(configPath, JSON.stringify(snapshot.config));
  await expect(
    withConfigFileTransaction(configPath, (transaction) =>
      transaction.write(
        { replaced: true },
        { expectedRevision: snapshot.revision },
      ),
    ),
  ).rejects.toBeInstanceOf(ConfigFileConflictError);
  expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(
    snapshot.config,
  );
});
