import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { TransportProcess } from "./transport-process.js";

let directory: string;
const children: TransportProcess[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "abot-local-host-"));
});
afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => child.kill()));
  await rm(directory, { recursive: true, force: true });
});

function start(): TransportProcess {
  const child = new TransportProcess(directory);
  children.push(child);
  return child;
}

test("separate simultaneous processes elect one owner and exchange canonical binary values", async () => {
  const peers = [start(), start(), start()];
  const ready = await Promise.all(peers.map((peer) => peer.ready()));
  expect(ready.filter((entry) => entry.ownership === "owner")).toHaveLength(1);
  const ownerPids = await Promise.all(
    peers.map((peer) => peer.call("ownerPid")),
  );
  expect(new Set(ownerPids).size).toBe(1);
  const creations = (await readFile(join(directory, "created.jsonl"), "utf8"))
    .trim()
    .split("\n");
  expect(creations).toEqual([String(ownerPids[0])]);
  const value = {
    date: new Date("2026-09-05T08:00:00Z"),
    binary: Buffer.from([0, 255]),
    absent: undefined,
  };
  for (const peer of peers) {
    expect(await peer.call("echo", value)).toEqual(value);
    expect(await peer.call("callback", 21)).toBe(42);
  }
  await peers[0].call("emit", { kind: "canonical_event", value });
  for (const peer of peers)
    expect(
      (await peer.waitFor((message) => message.kind === "event")).event,
    ).toEqual({ kind: "canonical_event", value });
}, 30_000);

test("client close detaches while owner close stops the environment and rejects other clients", async () => {
  const owner = start();
  expect((await owner.ready()).ownership).toBe("owner");
  const follower = start();
  expect((await follower.ready()).ownership).toBe("client");
  await follower.call("close");
  expect(await owner.call("echo", "still owned")).toBe("still owned");
  await expect(
    readFile(join(directory, "stopped.jsonl"), "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });
  const remaining = start();
  await remaining.ready();
  await owner.call("close");
  await expect(remaining.call("echo", "no replay")).rejects.toThrow(
    "local_runtime_connection_lost",
  );
  expect(
    (await readFile(join(directory, "stopped.jsonl"), "utf8")).trim(),
  ).toBe(String(owner.process.pid));
}, 30_000);

test("owner loss rejects an uncertain call once and does not reconnect or replay", async () => {
  const owner = start();
  await owner.ready();
  const follower = start();
  await follower.ready();
  const uncertain = follower.call("hold", "only-once");
  const failed = expect(uncertain).rejects.toThrow(
    "local_runtime_connection_lost",
  );
  await owner.waitFor((message) => message.kind === "invoked");
  await owner.kill();
  await failed;
  const replacement = start();
  expect((await replacement.ready()).ownership).toBe("owner");
  expect(await replacement.call("echo", "new owner")).toBe("new owner");
  await expect(follower.call("echo", "must stay disconnected")).rejects.toThrow(
    "local_runtime_connection_lost",
  );
  expect(
    replacement.messages.some((message) => message.kind === "invoked"),
  ).toBe(false);
  expect(
    (await readFile(join(directory, "created.jsonl"), "utf8"))
      .trim()
      .split("\n"),
  ).toHaveLength(2);
}, 30_000);
