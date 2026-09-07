import { constants } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, expect, test, vi } from "vitest";

import { runDirectoryAuthorityTask } from "./index.js";
import { AUTHORITY_MESSAGE_LIMIT } from "./protocol.js";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const close of resources.splice(0).reverse()) await close();
});

async function createDirectory(): Promise<{
  directoryPath: string;
  directoryFd: number;
  handle: FileHandle;
}> {
  const directoryPath = await mkdtemp(
    join(tmpdir(), "abot-directory-authority-"),
  );
  resources.push(() => rm(directoryPath, { recursive: true, force: true }));
  const handle = await open(
    directoryPath,
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  resources.push(() => handle.close());
  return { directoryPath, directoryFd: handle.fd, handle };
}

test("executes a real isolated operation without changing the parent cwd", async () => {
  const location = await createDirectory();
  const before = process.cwd();
  const input = { text: 'hello "world"\nשלום', name: "answer.txt" };
  const result = await runDirectoryAuthorityTask({
    ...location,
    input,
    task: async (value) => {
      const fs = require("node:fs") as typeof import("node:fs");
      fs.writeFileSync(value.name, value.text, { flag: "wx" });
      return { text: fs.readFileSync(value.name, "utf8"), pid: process.pid };
    },
  });
  expect(result.text).toBe(input.text);
  expect(result.pid).not.toBe(process.pid);
  expect(process.cwd()).toBe(before);
  expect(await readFile(join(location.directoryPath, input.name), "utf8")).toBe(
    input.text,
  );
});

test("rejects a replaced root before a task can write to the replacement", async () => {
  const location = await createDirectory();
  const moved = `${location.directoryPath}-held`;
  resources.push(() => rm(moved, { recursive: true, force: true }));
  await rename(location.directoryPath, moved);
  await mkdir(location.directoryPath);
  await expect(
    runDirectoryAuthorityTask({
      ...location,
      input: null,
      task: () => {
        require("node:fs").writeFileSync("escaped.txt", "unsafe");
      },
    }),
  ).rejects.toMatchObject({ code: "directory_authority_changed" });
  await expect(
    readFile(join(location.directoryPath, "escaped.txt")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(moved, "escaped.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("retains the held directory when its path is replaced after verification", async () => {
  const location = await createDirectory();
  const moved = `${location.directoryPath}-held`;
  resources.push(() => rm(moved, { recursive: true, force: true }));
  const running = runDirectoryAuthorityTask({
    ...location,
    input: null,
    task: async () => {
      const fs = require("node:fs") as typeof import("node:fs");
      fs.writeFileSync("ready", "verified");
      while (!fs.existsSync("continue"))
        await new Promise((resolve) => setTimeout(resolve, 5));
      fs.writeFileSync("answer.txt", "held directory");
    },
  });
  await vi.waitFor(async () =>
    expect(await readFile(join(location.directoryPath, "ready"), "utf8")).toBe(
      "verified",
    ),
  );
  await rename(location.directoryPath, moved);
  await mkdir(location.directoryPath);
  await writeFile(join(moved, "continue"), "go");
  await expect(running).resolves.toBeUndefined();
  expect(await readFile(join(moved, "answer.txt"), "utf8")).toBe(
    "held directory",
  );
  await expect(
    readFile(join(location.directoryPath, "answer.txt")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("transports task error code and data and rejects oversized results", async () => {
  const location = await createDirectory();
  await expect(
    runDirectoryAuthorityTask({
      ...location,
      input: null,
      task: () => {
        throw Object.assign(new Error("version changed"), {
          code: "filesystem_target_changed",
          data: { expected: "file" },
        });
      },
    }),
  ).rejects.toMatchObject({
    code: "filesystem_target_changed",
    message: "version changed",
    data: { expected: "file" },
  });
  await expect(
    runDirectoryAuthorityTask({
      ...location,
      input: AUTHORITY_MESSAGE_LIMIT,
      task: (length) => "x".repeat(length),
    }),
  ).rejects.toMatchObject({ code: "directory_authority_result_too_large" });
});

test("rejects oversized input before spawning and treats task console output as invalid protocol", async () => {
  const location = await createDirectory();
  await expect(
    runDirectoryAuthorityTask({
      ...location,
      input: "x".repeat(AUTHORITY_MESSAGE_LIMIT),
      task: () => undefined,
    }),
  ).rejects.toMatchObject({ code: "directory_authority_request_too_large" });
  await expect(
    runDirectoryAuthorityTask({
      ...location,
      input: null,
      task: () => {
        console.log("unexpected output");
        return null;
      },
    }),
  ).rejects.toMatchObject({ code: "directory_authority_protocol_error" });
});

test("terminates a stalled task at its deadline and honors pre-start cancellation", async () => {
  const location = await createDirectory();
  await expect(
    runDirectoryAuthorityTask({
      ...location,
      input: null,
      timeoutMs: 150,
      task: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60_000));
      },
    }),
  ).rejects.toMatchObject({ code: "directory_authority_timeout" });
  const controller = new AbortController();
  controller.abort();
  await expect(
    runDirectoryAuthorityTask({
      ...location,
      input: null,
      signal: controller.signal,
      task: () => undefined,
    }),
  ).rejects.toMatchObject({ code: "directory_authority_aborted" });
});

test("strips cwd-relative Node preloads and module paths before starting the helper", async () => {
  const location = await createDirectory();
  await writeFile(
    join(location.directoryPath, "preload.cjs"),
    'require("node:fs").writeFileSync("preloaded", "bad");',
  );
  vi.stubEnv("NODE_OPTIONS", "--require ./preload.cjs");
  vi.stubEnv("NODE_PATH", location.directoryPath);
  await expect(
    runDirectoryAuthorityTask({
      ...location,
      input: null,
      task: () => ({
        options: process.env.NODE_OPTIONS ?? null,
        path: process.env.NODE_PATH ?? null,
      }),
    }),
  ).resolves.toEqual({ options: null, path: null });
  await expect(
    readFile(join(location.directoryPath, "preloaded")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
