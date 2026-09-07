import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import { afterEach, expect, test } from "vitest";

import { spawnDirectoryAuthorityCommand } from "./index.js";

const resources: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
});

async function createDirectory(): Promise<{
  directoryPath: string;
  directoryFd: number;
}> {
  const directoryPath = await mkdtemp(
    join(tmpdir(), "abot-authority-command-"),
  );
  resources.push(() => rm(directoryPath, { recursive: true, force: true }));
  const handle = await open(
    directoryPath,
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  resources.push(() => handle.close());
  return { directoryPath, directoryFd: handle.fd };
}

function collect(
  child: ChildProcessByStdio<null, Readable, Readable>,
): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  error: string;
}> {
  let output = "";
  let error = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    error += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) =>
      resolve({ code, signal, output, error }),
    );
  });
}

test("runs a command from verified cwd and transports arguments and exit status", async () => {
  const location = await createDirectory();
  const child = spawnDirectoryAuthorityCommand({
    ...location,
    command: process.execPath,
    args: [
      "-e",
      'require("node:fs").writeFileSync("answer.txt",process.argv[1]);process.stdout.write("out");process.stderr.write("err");process.exitCode=7;',
      "quote '\" $() שלום",
    ],
  });
  expect(child.stdin).toBeNull();
  await expect(collect(child)).resolves.toEqual({
    code: 7,
    signal: null,
    output: "out",
    error: "err",
  });
  expect(
    await readFile(join(location.directoryPath, "answer.txt"), "utf8"),
  ).toBe("quote '\" $() שלום");
});

test("rejects a replaced root before launching the command", async () => {
  const location = await createDirectory();
  const moved = `${location.directoryPath}-held`;
  resources.push(() => rm(moved, { recursive: true, force: true }));
  await rename(location.directoryPath, moved);
  await mkdir(location.directoryPath);
  const result = await collect(
    spawnDirectoryAuthorityCommand({
      ...location,
      command: process.execPath,
      args: ["-e", 'require("node:fs").writeFileSync("escaped.txt", "bad")'],
    }),
  );
  expect(result.code).toBe(125);
  expect(JSON.parse(result.error).error.code).toBe(
    "directory_authority_changed",
  );
  await expect(
    readFile(join(location.directoryPath, "escaped.txt")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("reports a command spawn failure as a nonzero bounded helper error", async () => {
  const location = await createDirectory();
  const result = await collect(
    spawnDirectoryAuthorityCommand({
      ...location,
      command: join(location.directoryPath, "no-such-executable"),
      args: [],
    }),
  );
  expect(result.code).toBe(125);
  expect(JSON.parse(result.error).error.code).toBe("ENOENT");
});

test("terminating the detached group closes both the helper and its command", async () => {
  const location = await createDirectory();
  const child = spawnDirectoryAuthorityCommand({
    ...location,
    command: process.execPath,
    args: ["-e", 'process.stdout.write("ready");setInterval(()=>{},1000);'],
  });
  const ready = new Promise<void>((resolve) =>
    child.stdout.once("data", () => resolve()),
  );
  const result = collect(child);
  try {
    await ready;
    process.kill(-child.pid!, "SIGKILL");
    // The command inherits these pipes, so close cannot arrive while an
    // orphaned command still holds them open after its helper was killed.
    await expect(result).resolves.toMatchObject({
      code: null,
      signal: "SIGKILL",
      output: "ready",
    });
  } finally {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      /* Group already exited. */
    }
  }
});
