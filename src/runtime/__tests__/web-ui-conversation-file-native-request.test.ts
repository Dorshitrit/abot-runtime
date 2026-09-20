import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import {
  assertNativeFileOpenRequest,
  isLocalNativeFileRequest,
} from "../../web-ui/local-runtime/conversation-file-native-request.js";

function request(
  options: {
    host?: string;
    remoteAddress?: string;
    localAddress?: string;
    origin?: string;
    headers?: Record<string, string | undefined>;
  } = {},
) {
  return {
    headers: {
      host: options.host ?? "localhost:5177",
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...options.headers,
    },
    socket: {
      remoteAddress: options.remoteAddress ?? "127.0.0.1",
      localAddress: options.localAddress ?? "127.0.0.1",
      localPort: 5177,
    },
  } as IncomingMessage;
}

describe("local native file opening authority", () => {
  it.each([
    { host: "localhost:5177" },
    { host: "127.0.0.1:5177" },
    { host: "[::1]:5177", remoteAddress: "::1", localAddress: "::1" },
    {
      host: "127.0.0.1:5177",
      remoteAddress: "::ffff:127.0.0.1",
      localAddress: "::ffff:127.0.0.1",
    },
  ])("offers a native action for a direct local request %j", (options) => {
    expect(isLocalNativeFileRequest(request(options))).toBe(true);
  });

  it.each([
    { remoteAddress: "192.168.1.10" },
    { remoteAddress: "::ffff:192.168.1.10" },
    { remoteAddress: "fe80::1%en0" },
    { localAddress: "fe80::1%en0" },
    { localAddress: "192.168.1.5" },
    { host: "192.168.1.5:5177" },
    { host: "attacker.example:5177" },
    { host: "localhost.attacker.example:5177" },
    { host: "localhost:5178" },
    { host: "localhost:5177/path" },
    { origin: "http://localhost:5178" },
    { headers: { "sec-fetch-site": "cross-site" } },
    {
      remoteAddress: "192.168.1.5",
      headers: { "x-forwarded-for": "127.0.0.1" },
    },
  ])("rejects remote or untrusted requests %j", (options) => {
    expect(isLocalNativeFileRequest(request(options))).toBe(false);
  });

  it("allows missing Origin only for discovering availability, never dispatch", () => {
    const local = request({ headers: { "content-type": "application/json" } });
    expect(isLocalNativeFileRequest(local)).toBe(true);
    expect(() => assertNativeFileOpenRequest(local, "darwin")).toThrow();
    local.headers.origin = "http://localhost:5177";
    expect(() => assertNativeFileOpenRequest(local, "darwin")).not.toThrow();
    expect(() => assertNativeFileOpenRequest(local, "linux")).toThrow();
  });
});
