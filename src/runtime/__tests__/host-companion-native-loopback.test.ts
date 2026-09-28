import { once } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import type { NativeAddress } from "../../computer-access/companion/native-address.js";
import { nativeLoopbackFixture } from "./support/native-loopback-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

test.each([
  ["localhost", "127.0.0.1"],
  ["localhost", "::1"],
  ["abot.localhost", "127.0.0.1"],
  ["abot.localhost", "::1"],
] as const)("pairs %s once through an exclusive %s listener without external DNS", async (hostname, address) => {
  const f = await nativeLoopbackFixture(address, hostname);
  cleanups.push(f.close);
  const resolveHost = vi.fn(async () => { throw new Error("Unexpected external DNS"); });
  expect(await f.connect({ resolveHost })).toBe("disconnected");
  expect(resolveHost).not.toHaveBeenCalled();
  expect(f.onPaired).toHaveBeenCalledExactlyOnceWith(f.hostId, f.credential);
  expect(f.onReady).not.toHaveBeenCalled();
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]!.headers.host).toBe(`${hostname}:${f.port}`);
  expect(f.requests[0]!.headers.authorization).toBe(`Bearer ${f.credential}`);
  expect(f.messages).toHaveLength(1);
  expect(f.messages[0]).toMatchObject({ type: "hello" });
});

test("connects using the vetted DNS result without looking up the hostname again", async () => {
  const f = await nativeLoopbackFixture("::1", "runtime.invalid");
  cleanups.push(f.close);
  const resolveHost = vi.fn(async () => [
    { address: "127.0.0.1", family: 4 }, { address: "::1", family: 6 },
  ]);
  expect(await f.connect({ resolveHost })).toBe("disconnected");
  expect(resolveHost).toHaveBeenCalledExactlyOnceWith("runtime.invalid");
  expect(f.onPaired).toHaveBeenCalledExactlyOnceWith(f.hostId, f.credential);
  expect(f.requests).toHaveLength(1);
});

test.each([
  ["mixed public answers", [{ address: "127.0.0.1", family: 4 }, { address: "203.0.113.1", family: 4 }]],
  ["mismatched family", [{ address: "127.0.0.1", family: 6 }]],
  ["unknown family", [{ address: "127.0.0.1", family: 0 }]],
  ["empty answers", []],
] satisfies [string, NativeAddress[]][])("rejects %s before any WebSocket handshake", async (_name, addresses) => {
  const f = await nativeLoopbackFixture("127.0.0.1", "runtime.invalid");
  cleanups.push(f.close);
  const resolveHost = vi.fn(async () => addresses);
  await expect(f.connect({ resolveHost })).rejects.toThrow();
  expect(resolveHost).toHaveBeenCalledOnce();
  expect(f.requests).toHaveLength(0);
  expect(f.onPaired).not.toHaveBeenCalled();
});

test("cancels an opening IPv6 connection without pairing or another attempt", async () => {
  const f = await nativeLoopbackFixture("::1");
  cleanups.push(f.close);
  f.http.removeAllListeners("upgrade");
  const upgrade = once(f.http, "upgrade");
  const pending = f.connect();
  const [, socket] = await upgrade;
  const ended = once(socket, "end");
  socket.resume();
  f.stop.abort();
  expect(await pending).toBe("stopped");
  await ended;
  expect(f.requests).toHaveLength(0);
  expect(f.onPaired).not.toHaveBeenCalled();
});
