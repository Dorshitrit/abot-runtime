import { describe, expect, test } from "vitest";

import {
  findHardcodedGloballyRoutableIpv4,
  isNonGlobalOrSpecialUseIpv4,
  scanPublicTextFiles,
} from "../../../scripts/public-snapshot/content-scan.js";

describe("publication IPv4 policy", () => {
  test("accepts the canonical SSRF deny-policy IPv4 ranges", () => {
    const policyBases = [
      "0.0.0.0",
      "10.0.0.0",
      "100.64.0.0",
      "127.0.0.0",
      "169.254.0.0",
      "172.16.0.0",
      "192.0.0.0",
      "192.0.2.0",
      "192.88.99.0",
      "192.168.0.0",
      "198.18.0.0",
      "198.51.100.0",
      "203.0.113.0",
      "224.0.0.0",
      "240.0.0.0",
    ];

    expect(policyBases.every(isNonGlobalOrSpecialUseIpv4)).toBe(true);
    expect(
      findHardcodedGloballyRoutableIpv4(policyBases.join("\n")),
    ).toBeUndefined();
  });

  test("honors CIDR boundaries and still detects a real public address", () => {
    expect(isNonGlobalOrSpecialUseIpv4("100.127.255.255")).toBe(true);
    expect(isNonGlobalOrSpecialUseIpv4("172.31.255.255")).toBe(true);

    const publicAddress = [8, 8, 8, 8].join(".");
    expect(isNonGlobalOrSpecialUseIpv4(publicAddress)).toBe(false);
    expect(
      findHardcodedGloballyRoutableIpv4(`endpoint=http://${publicAddress}/`),
    ).toBe(publicAddress);
  });

  test("rejects inline OpenAI secret literals without self-matching the scanner", () => {
    const inlineSecret = ["sk", "test", "abcdefghijklmnop"].join("-");
    expect(() =>
      scanPublicTextFiles([
        {
          relativePath: "src/inline-secret.ts",
          bytes: Buffer.from(
            `export const value = ${JSON.stringify(inlineSecret)};`,
          ),
        },
      ]),
    ).toThrow(/inline OpenAI secret material/u);
  });
});
