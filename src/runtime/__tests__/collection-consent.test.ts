import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { ensurePrivateRuntimeDirectory } from "../local-host/private-directory.js";
import { verifyWindowsPrivateAccess } from "../local-host/windows-private-access.js";
import { assertWindowsPrivateFile } from "./support/windows-file-privacy.js";
import {
  acceptCollectionConsent,
  readCollectionConsent,
  requireCollectionConsent,
} from "../../computer-access/collection-consent.js";
import { readRuntimeCollectionSource } from "../../computer-access/observation-source.js";
import { HostPairingStore } from "../../computer-access/companion/pairing-store.js";
import { hostStateDirectory, writeHostPrivateJson } from "../../computer-access/companion/private-store.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function rootFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "abot-collection-consent-"));
  roots.push(root);
  return root;
}

function consentFile(root: string): string {
  return join(hostStateDirectory(root), "collection-consent.json");
}

test("missing consent denies collection without creating installation state", async () => {
  const root = await rootFixture();
  expect(readCollectionConsent(root)).toEqual({ accepted: false });
  expect(() => requireCollectionConsent(root)).toThrow("collection_consent_required");
  await expect(stat(join(root, ".runtime"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("acceptance persists the original timestamp and remains private", async () => {
  const root = await rootFixture();
  const before = Date.now();
  const accepted = await acceptCollectionConsent(root);
  expect(accepted).toEqual({ accepted: true, acceptedAt: expect.any(String) });
  expect(Date.parse(accepted.acceptedAt!)).toBeGreaterThanOrEqual(before);
  expect(Date.parse(accepted.acceptedAt!)).toBeLessThanOrEqual(Date.now());
  expect(readCollectionConsent(root)).toEqual(accepted);
  expect(() => requireCollectionConsent(root)).not.toThrow();
  const stored = await readFile(consentFile(root), "utf8");
  expect(JSON.parse(stored)).toEqual({ version: 1, acceptedAt: accepted.acceptedAt });

  const original = "2024-01-02T03:04:05.000Z";
  writeHostPrivateJson(consentFile(root), { version: 1, acceptedAt: original });
  expect(await acceptCollectionConsent(root)).toEqual({ accepted: true, acceptedAt: original });
  expect(await readFile(consentFile(root), "utf8")).toBe(JSON.stringify({ version: 1, acceptedAt: original }));
  if (process.platform === "win32") {
    await verifyWindowsPrivateAccess(hostStateDirectory(root));
    await assertWindowsPrivateFile(consentFile(root));
  } else {
    expect((await stat(consentFile(root))).mode & 0o077).toBe(0);
    expect((await stat(hostStateDirectory(root))).mode & 0o077).toBe(0);
  }
}, 30_000);

test("concurrent acknowledgments return one durable acceptance timestamp", async () => {
  const root = await rootFixture();
  const receipts = await Promise.all(Array.from({ length: 4 }, () => acceptCollectionConsent(root)));
  expect(receipts[0]).toEqual({ accepted: true, acceptedAt: expect.any(String) });
  for (const receipt of receipts) expect(receipt).toEqual(receipts[0]);
  const firstRecord = await readFile(consentFile(root), "utf8");
  const repeated = await Promise.all(Array.from({ length: 4 }, () => acceptCollectionConsent(root)));
  for (const receipt of repeated) expect(receipt).toEqual(receipts[0]);
  expect(await readFile(consentFile(root), "utf8")).toBe(firstRecord);
  expect(readCollectionConsent(root)).toEqual(receipts[0]);
}, 30_000);

test("consent survives config changes and pairing revocation but remains installation scoped", async () => {
  const root = await rootFixture();
  const otherRoot = await rootFixture();
  const accepted = await acceptCollectionConsent(root);
  await writeFile(join(root, "runtime.config.json"), JSON.stringify({ profile: "replacement" }));
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "99.0.0" }));
  const pairing = new HostPairingStore(root);
  const grant = pairing.begin();
  pairing.consume(grant.code, { name: "Test computer", os: "windows", user: "fixture", homeDir: "C:\\Users\\fixture" });
  new HostPairingStore(root).revoke();
  expect(readCollectionConsent(root)).toEqual(accepted);
  expect(readCollectionConsent(otherRoot)).toEqual({ accepted: false });
  expect(() => requireCollectionConsent(otherRoot)).toThrow("collection_consent_required");
}, 30_000);

test.each([
  { record: null }, { record: [] }, { record: {} },
  { record: { version: 2, acceptedAt: "2024-01-02T03:04:05.000Z" } },
  { record: { version: 1 } }, { record: { version: 1, acceptedAt: false } },
  { record: { version: 1, acceptedAt: "" } },
  { record: { version: 1, acceptedAt: "invalid-date" } },
])("malformed stored consent fails closed: $record", async ({ record }) => {
  const root = await rootFixture();
  await ensurePrivateRuntimeDirectory(hostStateDirectory(root));
  writeHostPrivateJson(consentFile(root), record);
  const original = await readFile(consentFile(root), "utf8");
  expect(readCollectionConsent(root)).toEqual({ accepted: false });
  expect(() => requireCollectionConsent(root)).toThrow("collection_consent_required");
  expect(await readFile(consentFile(root), "utf8")).toBe(original);
}, 30_000);

test("unparseable consent fails closed and explicit acceptance repairs the record", async () => {
  const root = await rootFixture();
  await ensurePrivateRuntimeDirectory(hostStateDirectory(root));
  writeHostPrivateJson(consentFile(root), {});
  await writeFile(consentFile(root), "{invalid json");
  expect(readCollectionConsent(root)).toEqual({ accepted: false });
  expect(() => requireCollectionConsent(root)).toThrow("collection_consent_required");
  const accepted = await acceptCollectionConsent(root);
  expect(readCollectionConsent(root)).toEqual(accepted);
  expect(accepted.accepted).toBe(true);
}, 30_000);

test.each([
  ["win32", { mode: "native", platform: "windows" }],
  ["darwin", { mode: "companion", platform: "macos" }],
  ["linux", { mode: "companion", platform: "linux" }],
  ["freebsd", { mode: "companion", platform: "unsupported" }],
] as const)("collection source is selected explicitly for %s", (platform, expected) => {
  expect(readRuntimeCollectionSource(platform)).toEqual(expected);
});
