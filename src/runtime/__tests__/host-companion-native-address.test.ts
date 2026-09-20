import { expect, test, vi } from "vitest";
import {
  isNativeLoopbackAddress,
  normalizeNativeRuntimeUrl,
  resolveNativeRuntimeAddress,
} from "../../../plugins/system/source/companion/native-address.js";

test("normalizes origin and pins localhost aliases without external DNS", async () => {
  const resolve = vi.fn();
  expect(normalizeNativeRuntimeUrl("http://abot-qa.localhost:5184/")).toBe(
    "ws://abot-qa.localhost:5184",
  );
  expect(
    await resolveNativeRuntimeAddress("http://abot-qa.localhost:5184", resolve),
  ).toEqual({
    url: "ws://abot-qa.localhost:5184/system-host/connect",
    address: { address: "127.0.0.1", family: 4 },
  });
  expect(resolve).not.toHaveBeenCalled();
});
test.each([
  "http://user:secret@localhost",
  "http://localhost/path",
  "http://localhost?token=secret",
  "file:///tmp/runtime",
])("rejects non-origin or credential URL %s", (url) => {
  expect(() => normalizeNativeRuntimeUrl(url)).toThrow();
});
test("rejects mixed DNS answers before opening a connection", async () => {
  await expect(
    resolveNativeRuntimeAddress("http://runtime.example", async () => [
      { address: "127.0.0.1", family: 4 },
      { address: "192.168.1.2", family: 4 },
    ]),
  ).rejects.toThrow("loopback");
});
test.each(["127.0.0.1", "127.42.0.9", "::1", "::ffff:127.0.0.1"])(
  "recognizes loopback address %s",
  (address) => {
    expect(isNativeLoopbackAddress(address)).toBe(true);
  },
);
test.each([
  "192.168.1.2",
  "0.0.0.0",
  "::",
  "::ffff:192.168.1.2",
  "localhost.example",
])("rejects non-loopback address %s", (address) => {
  expect(isNativeLoopbackAddress(address)).toBe(false);
});
