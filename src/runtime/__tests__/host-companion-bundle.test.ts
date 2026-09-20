import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { buildHostCompanionBundle } from "../../../scripts/build-host-companion.js";
import { ensurePrivateRuntimeDirectory } from "../local-host/private-directory.js";

const executeFile = promisify(execFile);
let directory: string;
let bundle: Awaited<ReturnType<typeof buildHostCompanionBundle>>;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "abot-standalone-companion-"));
  bundle = await buildHostCompanionBundle({
    rootDir: fileURLToPath(new URL("../../../", import.meta.url)),
    outputPath: join(directory, "host-companion-bundle.mjs"),
  });
});
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("bundles websocket and native handlers with only built-in external imports", () => {
  expect(bundle.bytes).toBeGreaterThan(1_000);
  expect(bundle.inputPaths).toContain("node_modules/ws/lib/websocket.js");
  expect(bundle.inputPaths).toContain("plugins/system/source/handlers.ts");
});
test("preserves the complete Runtime and installed websocket license notices", async () => {
  const wsRoot = dirname(
    createRequire(import.meta.url).resolve("ws/package.json"),
  );
  const [output, runtimeLicense, wsLicense] = await Promise.all([
    readFile(bundle.outputPath, "utf8"),
    readFile(new URL("../../../LICENSE", import.meta.url), "utf8"),
    readFile(join(wsRoot, "LICENSE"), "utf8"),
  ]);
  expect(runtimeLicense.length).toBeGreaterThan(100);
  expect(wsLicense.length).toBeGreaterThan(100);
  expect(output).toContain(runtimeLicense);
  expect(output).toContain(wsLicense);
});
test("runs the actual bundle in an isolated directory without npm dependencies", async () => {
  expect(await readdir(directory)).toEqual(["host-companion-bundle.mjs"]);
  const options = {
    cwd: directory,
    env: {
      ...process.env,
      HOME: directory,
      USERPROFILE: directory,
      APPDATA: join(directory, "app-data"),
    },
    timeout: 10_000,
    windowsHide: true,
  };
  const help = await executeFile(
    process.execPath,
    [bundle.outputPath, "host", "--help"],
    options,
  );
  expect(help.stdout).toContain("abot host");
  expect(help.stderr).toBe("");
  const status = await executeFile(
    process.execPath,
    [bundle.outputPath, "host", "status"],
    options,
  );
  expect(JSON.parse(status.stdout)).toEqual({
    paired: false,
    connected: false,
  });
  expect(status.stderr).toBe("");
  await expect(
    access(join(directory, ".abot", "host-companion", "connection.json")),
  ).rejects.toThrow();
});

test("the standalone bundle exchanges authenticated websocket messages without dispatching a system action", async () => {
  const runtime = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(runtime, "listening");
  const hostId = randomUUID();
  const credential = "a".repeat(43);
  const operationId = randomUUID();
  const nativeHome = join(directory, "transport-home");
  const state = join(nativeHome, ".abot", "host-companion");
  await ensurePrivateRuntimeDirectory(state);
  await writeFile(
    join(state, "connection.json"),
    JSON.stringify({
      version: 1,
      hostId,
      credential,
      url: `ws://127.0.0.1:${(runtime.address() as AddressInfo).port}`,
    }),
    { mode: 0o600 },
  );
  const received = new Promise<unknown>((resolve, reject) => {
    runtime.once("connection", (socket, request) => {
      if (request.headers.authorization !== `Bearer ${credential}`)
        return reject(new Error("Missing native authentication."));
      if (request.headers.origin !== undefined)
        return reject(new Error("Unexpected browser Origin."));
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === "result") return resolve(message);
        if (message.type !== "hello" || message.hostId !== hostId)
          return reject(new Error("Missing bound native identity."));
        socket.send(JSON.stringify({ type: "ready", hostId }));
        socket.send(
          JSON.stringify({
            type: "execute",
            id: operationId,
            hostId,
            operation: "system_command",
            params: { target: "invalid-target", command: "must-not-execute" },
          }),
        );
      });
    });
  });
  const child = spawn(process.execPath, [bundle.outputPath, "host", "run"], {
    cwd: directory,
    env: { ...process.env, HOME: nativeHome, USERPROFILE: nativeHome },
    stdio: "ignore",
    windowsHide: true,
  });
  const stopped = once(child, "exit");
  const deadline = setTimeout(() => child.kill(), 5_000);
  try {
    const message = await Promise.race([
      received,
      stopped.then(() => {
        throw new Error("Companion ended before protocol receipt.");
      }),
    ]);
    expect(message).toMatchObject({
      type: "result",
      id: operationId,
      result: { ok: false, errorCode: "system_target_unavailable" },
    });
  } finally {
    child.kill();
    await stopped;
    clearTimeout(deadline);
    for (const client of runtime.clients) client.terminate();
    await new Promise<void>((resolve) => runtime.close(() => resolve()));
  }
});
