import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const MAX_TEXT_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_TEXT_BYTES = 64 * 1024 * 1024;
const MAX_DENYLIST_TERMS = 100;
const LOCAL_DENYLIST_FILE = ".publication-denylist.local";
const DENYLIST_ENV = "PUBLIC_SNAPSHOT_DENYLIST_TERMS";

const IPV4_LITERAL_PATTERN = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/gu;
const INLINE_OPENAI_SECRET_PATTERN = new RegExp(
  String.raw`\b${["s", "k"].join("")}-(?:proj|live|test)-[A-Za-z0-9_-]{12,}\b`,
  "u",
);
const NON_GLOBAL_OR_SPECIAL_USE_IPV4_CIDRS = Object.freeze([
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
] as const);

export type PublicTextFile = Readonly<{ relativePath: string; bytes: Buffer }>;

function ipv4Value(address: string): number | undefined {
  const octets = address.split(".");
  if (
    octets.length !== 4 ||
    octets.some(
      (octet) => !/^(?:0|[1-9]\d{0,2})$/u.test(octet) || Number(octet) > 255,
    )
  ) {
    return undefined;
  }
  return octets.reduce((value, octet) => value * 256 + Number(octet), 0);
}

function ipv4InCidr(value: number, base: number, bits: number): boolean {
  const blockSize = 2 ** (32 - bits);
  return Math.floor(value / blockSize) === Math.floor(base / blockSize);
}

export function isNonGlobalOrSpecialUseIpv4(address: string): boolean {
  const value = ipv4Value(address);
  if (value === undefined) return false;
  return NON_GLOBAL_OR_SPECIAL_USE_IPV4_CIDRS.some(([base, bits]) =>
    ipv4InCidr(value, ipv4Value(base)!, bits),
  );
}

export function findHardcodedGloballyRoutableIpv4(
  text: string,
): string | undefined {
  for (const match of text.matchAll(IPV4_LITERAL_PATTERN)) {
    const address = match[0];
    if (
      ipv4Value(address) !== undefined &&
      !isNonGlobalOrSpecialUseIpv4(address)
    ) {
      return address;
    }
  }
  return undefined;
}

function decodeTerms(text: string): string[] {
  return text
    .split(/[\r\n,]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 0 && !term.startsWith("#"));
}

export async function loadBuildOnlyDenylistTerms(
  sourceRoot: string,
): Promise<readonly string[]> {
  const terms = decodeTerms(process.env[DENYLIST_ENV] ?? "");
  const path = resolve(sourceRoot, LOCAL_DENYLIST_FILE);
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`${LOCAL_DENYLIST_FILE} must be a physical regular file`);
    }
    if (stats.size > 32 * 1024) {
      throw new Error(`${LOCAL_DENYLIST_FILE} is too large`);
    }
    terms.push(...decodeTerms(await readFile(path, "utf-8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const unique = [...new Set(terms)];
  if (
    unique.length > MAX_DENYLIST_TERMS ||
    unique.some((term) => term.length > 256)
  ) {
    throw new Error("publication denylist exceeds its bounded term contract");
  }
  return Object.freeze(unique);
}

export function scanPublicTextFiles(
  files: readonly PublicTextFile[],
  denylistTerms: readonly string[] = [],
): void {
  let totalBytes = 0;
  const normalizedTerms = denylistTerms.map((term) =>
    term.toLocaleLowerCase("en-US"),
  );
  for (const file of files) {
    if (file.bytes.includes(0)) continue;
    if (file.bytes.byteLength > MAX_TEXT_FILE_BYTES) {
      throw new Error(
        `public text file exceeds scan bound: ${file.relativePath}`,
      );
    }
    totalBytes += file.bytes.byteLength;
    if (totalBytes > MAX_TOTAL_TEXT_BYTES) {
      throw new Error("public text scan exceeds its total byte bound");
    }
    const text = file.bytes.toString("utf-8");
    const globallyRoutableIpv4 = findHardcodedGloballyRoutableIpv4(text);
    if (globallyRoutableIpv4) {
      throw new Error(
        `public text contains a hardcoded globally routable IPv4 address: ${file.relativePath}`,
      );
    }
    const genericPath =
      /(?:\/(?:home|Users)\/[^/\s]+\/|[A-Za-z]:\\Users\\|\\\\(?:wsl(?:\.localhost)?|wsl\$)\\)/u;
    const sensitiveAssignment =
      /^[ \t]*[A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|PASSWORD|SECRET)[ \t]*=[ \t]*([^ \t\r\n#]+)[ \t]*$/gmu;
    if (genericPath.test(text)) {
      throw new Error(
        `public text contains a machine-specific path: ${file.relativePath}`,
      );
    }
    const privateKeyHeader = "-----BEGIN " + "PRIVATE KEY-----";
    if (text.includes(privateKeyHeader)) {
      throw new Error(
        `public text contains private key material: ${file.relativePath}`,
      );
    }
    if (INLINE_OPENAI_SECRET_PATTERN.test(text)) {
      throw new Error(
        `public text contains inline OpenAI secret material: ${file.relativePath}`,
      );
    }
    for (const match of text.matchAll(sensitiveAssignment)) {
      const value = match[1].replace(/^['"]|['"]$/gu, "");
      if (
        value !== "" &&
        !value.startsWith("${") &&
        !value.startsWith("<") &&
        !/^(?:\.\.\.|change-me|example|placeholder|replace-me)$/iu.test(value)
      ) {
        throw new Error(
          `public text contains a populated secret assignment: ${file.relativePath}`,
        );
      }
    }
    const normalizedText = text.toLocaleLowerCase("en-US");
    const matchedTerm = normalizedTerms.find((term) =>
      normalizedText.includes(term),
    );
    if (matchedTerm !== undefined) {
      throw new Error(
        `public text matches a local publication denylist term: ${file.relativePath}`,
      );
    }
  }
}
