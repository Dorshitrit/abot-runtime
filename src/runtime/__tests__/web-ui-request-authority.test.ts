import type { IncomingMessage } from "node:http";
import { describe, expect, test, vi } from "vitest";
import type { Duplex } from "node:stream";
import {
  hasTrustedWebUiAuthority,
  acceptWebUiUpgradeAuthority,
} from "../../web-ui/request-authority.js";
import { assertConfigMutationRequest } from "../../web-ui/local-runtime/config-mutation-request.js";

function request(
  host: string,
  localAddress = "127.0.0.1",
  localPort = 5177,
  headers: Record<string, string> = {},
): IncomingMessage {
  return {
    headers: { host, "content-type": "application/json", ...headers },
    rawHeaders: ["Host", host],
    socket: { localAddress, localPort },
  } as unknown as IncomingMessage;
}

describe("Web UI trusted listener authority", () => {
  test.each([
    ["127.0.0.1:5177", "127.0.0.1", "127.0.0.1"],
    ["localhost:5177", "127.0.0.1", "127.0.0.1"],
    ["LOCALHOST.:5177", "127.0.0.1", "127.0.0.1"],
    ["[::1]:5177", "::1", "::1"],
    ["localhost:5177", "::1", "::"],
    ["127.0.0.1:5177", "::ffff:127.0.0.1", "::"],
    ["[::ffff:127.0.0.1]:5177", "::ffff:7f00:1", "::"],
    ["127.0.0.2:5177", "127.0.0.1", "127.0.0.1"],
    ["192.168.1.20:5177", "192.168.1.20", "0.0.0.0"],
    ["192.168.1.20:5177", "::ffff:192.168.1.20", "::"],
    ["[fd00::20]:5177", "fd00:0:0:0:0:0:0:20", "::"],
    ["agent.internal:5177", "192.168.1.20", "agent.internal"],
    ["AGENT.INTERNAL.:5177", "192.168.1.20", "agent.internal"],
  ])("accepts %s at %s for listener %s", (host, address, listener) => {
    expect(hasTrustedWebUiAuthority(request(host, address), listener)).toBe(
      true,
    );
  });

  test.each(["same-origin", "same-site", "none", ""])(
    "matching hostile Origin cannot establish trusted authority with metadata %s",
    (site) => {
      const incoming = request("attacker.example:5177", "127.0.0.1", 5177, {
        origin: "http://attacker.example:5177",
        "sec-fetch-site": site,
      });
      expect(() => assertConfigMutationRequest(incoming)).not.toThrow();
      expect(hasTrustedWebUiAuthority(incoming, "127.0.0.1")).toBe(false);
    },
  );

  test("absent Origin and spoofed proxy headers cannot authorize an unknown hostname", () => {
    const incoming = request("attacker.example:5177", "127.0.0.1", 5177, {
      "x-forwarded-host": "localhost:5177",
      "x-forwarded-proto": "http",
      forwarded: "host=localhost:5177;proto=http",
    });
    expect(hasTrustedWebUiAuthority(incoming, "127.0.0.1")).toBe(false);
  });

  test.each([
    ["attacker.example:5177", "127.0.0.1", "0.0.0.0"],
    ["attacker.example:5177", "::1", "::"],
    ["attacker.example:5177", "192.168.1.20", "*"],
    ["localhost.attacker.example:5177", "127.0.0.1", "127.0.0.1"],
    ["localhost:5177", "192.168.1.20", "0.0.0.0"],
    ["127.0.0.1:5177", "192.168.1.20", "0.0.0.0"],
    ["192.168.1.21:5177", "192.168.1.20", "0.0.0.0"],
    ["0.0.0.0:5177", "127.0.0.1", "0.0.0.0"],
    ["[::]:5177", "::1", "::"],
    ["alias.internal:5177", "192.168.1.20", "agent.internal"],
  ])("rejects %s at %s for listener %s", (host, address, listener) => {
    expect(hasTrustedWebUiAuthority(request(host, address), listener)).toBe(
      false,
    );
  });

  test.each([
    "",
    "localhost",
    "localhost:5178",
    "localhost:5177/path",
    "localhost:5177?query",
    "localhost:5177#fragment",
    "name@localhost:5177",
    "localhost:5177,attacker.example:5177",
    "localhost:5177\\attacker.example",
    " localhost:5177",
    "localhost:65536",
    "[::1",
  ])("rejects malformed or wrong-port authority %s", (host) => {
    expect(hasTrustedWebUiAuthority(request(host), "127.0.0.1")).toBe(false);
  });

  test("requires one Host header and actual bound socket information", () => {
    const incoming = request("localhost:5177");
    incoming.rawHeaders.push("host", "attacker.example:5177");
    expect(hasTrustedWebUiAuthority(incoming, "127.0.0.1")).toBe(false);
    incoming.rawHeaders = [];
    expect(hasTrustedWebUiAuthority(incoming, "127.0.0.1")).toBe(false);
    const withoutAddress = request("localhost:5177", "");
    expect(hasTrustedWebUiAuthority(withoutAddress, "localhost")).toBe(false);
  });

  test("uses the actual ephemeral or default listener port", () => {
    expect(
      hasTrustedWebUiAuthority(
        request("localhost:43123", "127.0.0.1", 43123),
        "127.0.0.1",
      ),
    ).toBe(true);
    expect(
      hasTrustedWebUiAuthority(
        request("localhost", "127.0.0.1", 80),
        "127.0.0.1",
      ),
    ).toBe(true);
    const secure = request("localhost", "::1", 443);
    Object.assign(secure.socket, { encrypted: true });
    expect(hasTrustedWebUiAuthority(secure, "::1")).toBe(true);
  });

  test("trusted Host does not waive existing Origin and JSON requirements", () => {
    const incoming = request("127.0.0.1:5177", "127.0.0.1", 5177, {
      origin: "https://other.example",
    });
    expect(hasTrustedWebUiAuthority(incoming, "127.0.0.1")).toBe(true);
    expect(() => assertConfigMutationRequest(incoming)).toThrow(/same origin/);
    incoming.headers.origin = "null";
    expect(() => assertConfigMutationRequest(incoming)).toThrow(/same origin/);
    incoming.headers.origin = "http://127.0.0.1:5177";
    incoming.headers["content-type"] = "text/plain";
    expect(() => assertConfigMutationRequest(incoming)).toThrow(
      /application.json/,
    );
  });
});

test.each([
  [undefined, true],
  ["http://localhost:5177", true],
  ["https://attacker.example", false],
  ["null", false],
  ["", false],
  ["http://localhost:5178", false],
  ["https://localhost:5177", false],
])(
  "WebSocket upgrade checks Origin %j after trusting Host",
  (origin, allowed) => {
    const incoming = request(
      "localhost:5177",
      "127.0.0.1",
      5177,
      origin === undefined ? {} : { origin },
    );
    const socket = { destroy: vi.fn() };
    expect(
      acceptWebUiUpgradeAuthority(
        incoming,
        socket as unknown as Duplex,
        "127.0.0.1",
      ),
    ).toBe(allowed);
    expect(socket.destroy).toHaveBeenCalledTimes(allowed ? 0 : 1);
  },
);
