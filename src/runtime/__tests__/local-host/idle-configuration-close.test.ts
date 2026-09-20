import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { createLocalRuntimeConnection } from "../../local-host/transport.js";
import type { LocalRuntimeConnection } from "../../local-host/contracts.js";

const paths: string[] = [];
const connections: LocalRuntimeConnection[] = [];
afterEach(async () => {
  await Promise.all(
    connections.splice(0).map((connection) => connection.close()),
  );
  await Promise.all(
    paths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "abot-idle-config-"));
  paths.push(directory);
  let idle = false;
  let accepting = true;
  const stop = vi.fn(async () => {
    accepting = false;
  });
  const options = {
    directory,
    identity: "configuration-v1",
    createOwner: async () => ({
      call: async () => {
        if (!accepting) throw new Error("closed");
        return "preserved";
      },
      subscribe: () => () => undefined,
      stop,
      isIdle: () => idle,
    }),
  };
  const owner = await createLocalRuntimeConnection(options);
  connections.push(owner);
  return {
    owner,
    options,
    stop,
    setIdle: () => {
      idle = true;
    },
    accepting: () => accepting,
  };
}

test("busy apply leaves owner admission, transport and state usable", async () => {
  const { owner, stop } = await fixture();
  expect(owner.isOwnerIdle()).toBe(false);
  expect(await owner.closeIfIdle()).toBe(false);
  expect(stop).not.toHaveBeenCalled();
  expect(await owner.call("read")).toBe("preserved");
});

test("an attached client cannot stop even an idle owner", async () => {
  const { owner, options, stop, setIdle } = await fixture();
  const client = await createLocalRuntimeConnection(options);
  connections.push(client);
  setIdle();
  expect(client.ownership).toBe("client");
  expect(client.isOwnerIdle()).toBe(false);
  expect(await client.closeIfIdle()).toBe(false);
  expect(stop).not.toHaveBeenCalled();
  expect(await owner.call("read")).toBe("preserved");
  await client.close();
  expect(await client.closeIfIdle()).toBe(false);
});

test("idle closure closes admission synchronously and releases identity before replacement", async () => {
  const { owner, options, setIdle, accepting } = await fixture();
  setIdle();
  expect(owner.isOwnerIdle()).toBe(true);
  const closing = owner.closeIfIdle();
  expect(accepting()).toBe(false);
  expect(await closing).toBe(true);
  const replacement = await createLocalRuntimeConnection({
    ...options,
    identity: "configuration-v2",
  });
  connections.push(replacement);
  expect(replacement.ownership).toBe("owner");
});
