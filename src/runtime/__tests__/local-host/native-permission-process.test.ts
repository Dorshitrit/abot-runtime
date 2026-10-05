import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { TransportProcess } from "./transport-process.js";
import type { NativePermissionStatus } from "../../../computer-access/native-permission-contract.js";

test("an attached UI process prepares native permissions inside the existing Runtime owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "abot-native-permission-owner-"));
  const worker = new URL("./native-permission-worker.ts", import.meta.url);
  const owner = new TransportProcess(directory, "permissions-environment", worker);
  let client: TransportProcess | undefined;
  try {
    expect((await owner.ready()).ownership).toBe("owner");
    client = new TransportProcess(directory, "permissions-environment", worker);
    expect((await client.ready()).ownership).toBe("client");
    const metadata = await client.call("status") as NativePermissionStatus;
    if (!metadata.available) throw new Error("fixture unavailable");
    await expect(readFile(join(directory, "permission-executor.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await client.call("prepare", { ownerId: metadata.ownerId, action: "request", permission: "accessibility" })).toMatchObject({ ownerId: metadata.ownerId, permissions: { accessibility: "granted" } });
    expect(JSON.parse((await readFile(join(directory, "permission-executor.jsonl"), "utf8")).trim())).toEqual({
      pid: owner.process.pid, action: { action: "request", permission: "accessibility" },
    });
    expect(owner.process.pid).not.toBe(client.process.pid);
  } finally {
    await client?.kill();
    await owner.kill();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
