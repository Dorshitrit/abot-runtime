import type { IncomingMessage } from "node:http";
import { describe, expect, test } from "vitest";
import { isLocalChatGptManagementRequest } from "./request-authority.js";

function request(headers: Record<string, string> = {}, socket: Record<string, unknown> = {}) {
  return {
    headers: { host: "127.0.0.1:5196", ...headers },
    rawHeaders: ["Host", headers.host ?? "127.0.0.1:5196"],
    socket: { localAddress: "172.17.0.2", remoteAddress: "172.17.0.1", localPort: 5177, ...socket },
  } as unknown as IncomingMessage;
}

describe("ChatGPT published account authority", () => {
  test("permits a trusted loopback publication with different host and listener ports", () => {
    expect(isLocalChatGptManagementRequest(request({ origin: "http://127.0.0.1:5196", "sec-fetch-site": "same-origin" }), true)).toBe(true);
    expect(isLocalChatGptManagementRequest(request(), false)).toBe(false);
  });
  test.each<Record<string, string>>([
    { origin: "https://attacker.example" },
    { "sec-fetch-site": "cross-site" },
    { host: "attacker.example:5196", "x-forwarded-host": "127.0.0.1:5196" },
    { host: "172.17.0.2:5177" },
  ])("rejects nonlocal management authority %j", (headers) => {
    expect(isLocalChatGptManagementRequest(request(headers), true)).toBe(false);
  });
  test("rejects duplicate hosts and TLS publication", () => {
    const duplicate = request();
    duplicate.rawHeaders.push("Host", "127.0.0.1:9999");
    expect(isLocalChatGptManagementRequest(duplicate, true)).toBe(false);
    expect(isLocalChatGptManagementRequest(request({}, { encrypted: true }), true)).toBe(false);
  });
  test("retains direct native loopback without Docker trust", () => {
    expect(isLocalChatGptManagementRequest(request({}, { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1", localPort: 5196 }), false)).toBe(true);
  });
});
