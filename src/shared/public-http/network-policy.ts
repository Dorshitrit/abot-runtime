import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { PublicHttpError } from "./errors.js";

export type PublicAddress = Readonly<{
  address: string;
  family: 4 | 6;
}>;

export type HostResolver = (
  hostname: string,
) => Promise<readonly PublicAddress[]>;

function ipv4Value(address: string): number | undefined {
  if (isIP(address) !== 4) return undefined;
  const octets = address.split(".").map(Number);
  return (
    ((octets[0]! << 24) >>> 0) +
    (octets[1]! << 16) +
    (octets[2]! << 8) +
    octets[3]!
  );
}

function ipv4InCidr(value: number, base: number, bits: number): boolean {
  const shift = 32 - bits;
  return value >>> shift === base >>> shift;
}

export function isPublicIpv4(address: string): boolean {
  const value = ipv4Value(address);
  if (value === undefined) return false;
  const blocked = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const;
  return !blocked.some(([base, bits]) =>
    ipv4InCidr(value, ipv4Value(base)!, bits),
  );
}

function parseIpv6(address: string): bigint | undefined {
  const normalized = address.toLowerCase().replace(/^\[|\]$/gu, "");
  if (normalized.includes("%") || isIP(normalized) !== 6) return undefined;
  let candidate = normalized;
  const ipv4Tail = candidate.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  if (ipv4Tail) {
    const value = ipv4Value(ipv4Tail);
    if (value === undefined) return undefined;
    candidate = candidate.slice(0, -ipv4Tail.length);
    candidate += `${((value >>> 16) & 0xffff).toString(16)}:${(
      value & 0xffff
    ).toString(16)}`;
  }
  const doubleColon = candidate.indexOf("::");
  if (doubleColon !== candidate.lastIndexOf("::")) return undefined;
  const head = (doubleColon >= 0 ? candidate.slice(0, doubleColon) : candidate)
    .split(":")
    .filter(Boolean);
  const tail = (doubleColon >= 0 ? candidate.slice(doubleColon + 2) : "")
    .split(":")
    .filter(Boolean);
  const missing = 8 - head.length - tail.length;
  if ((doubleColon < 0 && missing !== 0) || (doubleColon >= 0 && missing < 1)) {
    return undefined;
  }
  const groups = [...head, ...Array(missing).fill("0"), ...tail];
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))
  ) {
    return undefined;
  }
  return groups.reduce(
    (value, group) => (value << 16n) | BigInt(Number.parseInt(group, 16)),
    0n,
  );
}

function ipv6InCidr(value: bigint, baseAddress: string, bits: number): boolean {
  const base = parseIpv6(baseAddress)!;
  const shift = BigInt(128 - bits);
  return value >> shift === base >> shift;
}

export function isPublicIpv6(address: string): boolean {
  const value = parseIpv6(address);
  if (value === undefined) return false;
  if (ipv6InCidr(value, "::ffff:0:0", 96)) {
    const mapped = Number(value & 0xffff_ffffn) >>> 0;
    const dotted = [24, 16, 8, 0]
      .map((shift) => (mapped >>> shift) & 0xff)
      .join(".");
    return isPublicIpv4(dotted);
  }
  if (
    ipv6InCidr(value, "64:ff9b::", 96) ||
    ipv6InCidr(value, "64:ff9b:1::", 48)
  ) {
    return false;
  }
  if (!ipv6InCidr(value, "2000::", 3)) return false;
  const blocked = [
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3fff::", 20],
  ] as const;
  return !blocked.some(([base, bits]) => ipv6InCidr(value, base, bits));
}

export function isPublicAddress(address: PublicAddress): boolean {
  return address.family === 4
    ? isPublicIpv4(address.address)
    : isPublicIpv6(address.address);
}

function normalizeHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "");
}

function isBlockedHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home") ||
    hostname.endsWith(".lan")
  );
}

export function parsePublicHttpUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new PublicHttpError(
      "web_target_invalid",
      "A valid absolute URL is required.",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new PublicHttpError(
      "web_target_invalid",
      "Only http and https URLs are supported.",
    );
  }
  if (parsed.username || parsed.password) {
    throw new PublicHttpError(
      "web_target_invalid",
      "URLs containing credentials are not supported.",
    );
  }
  const hostname = normalizeHostname(parsed.hostname);
  if (!hostname || isBlockedHostname(hostname)) {
    throw new PublicHttpError(
      "web_target_not_public",
      "Only public Internet targets are allowed.",
    );
  }
  const family = isIP(hostname);
  if (
    (family === 4 && !isPublicIpv4(hostname)) ||
    (family === 6 && !isPublicIpv6(hostname))
  ) {
    throw new PublicHttpError(
      "web_target_not_public",
      "Only public Internet targets are allowed.",
    );
  }
  return parsed;
}

export const resolveHostAddresses: HostResolver = async (hostname) => {
  const normalized = normalizeHostname(hostname);
  const literalFamily = isIP(normalized);
  if (literalFamily === 4 || literalFamily === 6) {
    return Object.freeze([
      Object.freeze({ address: normalized, family: literalFamily }),
    ]);
  }
  let resolved: readonly { address: string; family: number }[];
  try {
    resolved = await lookup(normalized, { all: true, verbatim: true });
  } catch {
    throw new PublicHttpError(
      "web_target_unresolvable",
      "The public target hostname could not be resolved.",
    );
  }
  const addresses = resolved
    .filter(
      (entry): entry is { address: string; family: 4 | 6 } =>
        entry.family === 4 || entry.family === 6,
    )
    .map((entry) =>
      Object.freeze({ address: entry.address, family: entry.family }),
    );
  if (addresses.length === 0) {
    throw new PublicHttpError(
      "web_target_unresolvable",
      "The public target hostname could not be resolved.",
    );
  }
  return Object.freeze(addresses);
};

export async function resolvePublicTarget(
  url: URL,
  resolver: HostResolver = resolveHostAddresses,
): Promise<PublicAddress> {
  const hostname = normalizeHostname(url.hostname);
  const addresses = await resolver(hostname);
  if (
    addresses.length === 0 ||
    addresses.some((entry) => !isPublicAddress(entry))
  ) {
    throw new PublicHttpError(
      "web_target_not_public",
      "Only public Internet targets are allowed.",
    );
  }
  return addresses[0]!;
}
