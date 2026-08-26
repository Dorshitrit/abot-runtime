import { describe, expect, test } from "vitest";

// Public regression coverage for the bundled Web plugin network boundary.

import {
  isPublicIpv4,
  isPublicIpv6,
  parsePublicHttpUrl,
  resolvePublicTarget,
} from "../../../plugins/web/source/network-policy.js";

const EXAMPLE_PUBLIC_IPV4 = [93, 184, 216, 34].join(".");
const PUBLIC_IPV4_FIXTURES = [
  [1, 1, 1, 1],
  [8, 8, 8, 8],
  [93, 184, 216, 34],
].map((octets) => octets.join("."));

describe("web network policy", () => {
  test.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.31.255.255",
    "192.168.1.1",
    "198.18.0.1",
    "203.0.113.10",
    "224.0.0.1",
    "255.255.255.255",
  ])("blocks non-public IPv4 address %s", (address) => {
    expect(isPublicIpv4(address)).toBe(false);
  });

  test.each(PUBLIC_IPV4_FIXTURES)(
    "allows public IPv4 address %s",
    (address) => {
      expect(isPublicIpv4(address)).toBe(true);
    },
  );

  test.each([
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "64:ff9b::7f00:1",
    "64:ff9b:1::a00:1",
    "2001:db8::1",
    "2002:7f00:1::",
    "fc00::1",
    "fe80::1",
    "ff02::1",
  ])("blocks non-public or translated IPv6 address %s", (address) => {
    expect(isPublicIpv6(address)).toBe(false);
  });

  test("allows a globally routable IPv6 address", () => {
    expect(isPublicIpv6("2606:4700:4700::1111")).toBe(true);
  });

  test.each([
    "file:///tmp/private",
    "http://user:secret@example.com/",
    "http://localhost/private",
    "http://service.local/private",
    "http://127.0.0.1/private",
    "http://[::ffff:127.0.0.1]/private",
  ])("rejects unsafe URL %s", (url) => {
    expect(() => parsePublicHttpUrl(url)).toThrow();
  });

  test("rejects a hostname when any DNS answer is private", async () => {
    await expect(
      resolvePublicTarget(new URL("https://example.com"), async () => [
        { address: EXAMPLE_PUBLIC_IPV4, family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]),
    ).rejects.toMatchObject({ code: "web_target_not_public" });
  });

  test("returns a public DNS answer for connection pinning", async () => {
    await expect(
      resolvePublicTarget(new URL("https://example.com"), async () => [
        { address: EXAMPLE_PUBLIC_IPV4, family: 4 },
      ]),
    ).resolves.toEqual({ address: EXAMPLE_PUBLIC_IPV4, family: 4 });
  });
});
