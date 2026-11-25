import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { WebNotificationStore } from "../../web-ui/notifications/store.js";
import type { NotificationIssueOccurrence } from "../../web-ui/notifications/issue-contracts.js";
import { NOTIFICATION_RETENTION_MS } from "../../web-ui/notifications/retention.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "notification-issues-"));
  roots.push(root);
  let now = 10_000_000_000;
  const writes: number[] = [];
  const path = join(root, "history.json");
  const open = () => new WebNotificationStore(path, "dev", { now: () => now, onSaved: (bytes) => writes.push(bytes) });
  return { path, writes, store: open(), open, now: () => now, advance: (ms: number) => { now += ms; } };
}
function occurrence(id: string, occurredAt: number, overrides: Partial<NotificationIssueOccurrence> = {}): NotificationIssueOccurrence {
  return { environmentId: "dev", namespace: "source", occurrenceId: id, occurredAt, outcome: "recovered",
    title: "Setting rejected", body: "Recovered using the default.",
    grouping: { source: "adapter", provider: "provider", profile: "profile", cause: "setting", remediationTarget: "profile", configuration: { effort: "none" } },
    action: { kind: "model-settings", profileId: "profile" }, ...overrides };
}

test("39 occurrences share one group/write; restart, duplicate and ordinary reads are write-free", async () => {
  const f = await fixture();
  const batch = Array.from({ length: 39 }, (_, i) => occurrence(`event-${i}`, f.now() - i));
  expect(await f.store.ingestIssues(batch)).toEqual({ accepted: 39, rejected: 0, duplicate: 0 });
  expect(f.writes).toHaveLength(1);
  const first = await f.store.list();
  expect(await f.store.updateDelivery(first.items[0].id, { status: "pending" })).toBe(false);
  expect(first).toMatchObject({ unreadCount: 1, unreadErrorCount: 1, readBoundary: 39,
    items: [{ severity: "error", channel: "in-app", delivery: { status: "disabled" },
      issue: { occurrenceCount: 39, outcomeCounts: { recovered: 39, failed: 0, interrupted: 0 } } }] });
  expect(await f.open().ingestIssues(batch)).toEqual({ accepted: 0, rejected: 0, duplicate: 39 });
  f.advance(100);
  await f.store.list();
  await f.store.list({ limit: 1 });
  expect(f.writes).toHaveLength(1);
  console.info(`Issue batch measurement: 39 occurrences, ${f.writes.length} atomic write, ${f.writes[0]} serialized bytes.`);
});

test("read-through counts and global boundary preserve unseen recurrences and reopen the same instance", async () => {
  const f = await fixture();
  await f.store.ingestIssues([occurrence("a", f.now())]);
  const snapshot = await f.store.list();
  const id = snapshot.items[0].id;
  f.advance(1);
  await f.store.ingestIssues([occurrence("b", f.now(), { outcome: "failed", body: "Recovery failed." })]);
  expect(await f.store.markRead({ ids: [id], read: true, observedIssues: [{ id, occurrenceCount: 1 }] })).toMatchObject({ updated: 0, unreadErrorCount: 1,
    issueStates: [{ id, occurrenceCount: 2, body: "Recovery failed.", issue: { outcomeCounts: { recovered: 1, failed: 1, interrupted: 0 } } }] });
  expect(await f.store.markRead({ all: true, read: true, issueReadBoundary: snapshot.readBoundary })).toMatchObject({ updated: 0, unreadErrorCount: 1 });
  expect(await f.store.markRead({ ids: [id], read: true })).toMatchObject({ updated: 0 });
  expect(await f.store.markRead({ ids: [id], read: true, observedIssues: [{ id, occurrenceCount: 2 }] })).toMatchObject({ updated: 1, unreadErrorCount: 0 });
  await f.store.ingestIssues([occurrence("b", f.now())]);
  expect((await f.store.list()).unreadErrorCount).toBe(0);
  await f.store.markRead({ ids: [id], read: false });
  expect((await f.store.list()).unreadErrorCount).toBe(1);
  await f.store.markRead({ all: true, read: true, issueReadBoundary: 2 });
  f.advance(1);
  await f.store.ingestIssues([occurrence("c", f.now())]);
  expect((await f.store.list()).items[0]).toMatchObject({ id, readAt: null, createdAt: snapshot.items[0].createdAt, issue: { occurrenceCount: 3 } });
});

test("1000-group retention preserves createdAt and a real post-eviction occurrence gets a fresh identity", async () => {
  const f = await fixture();
  await f.store.ingestIssues([occurrence("first", f.now())]);
  const original = (await f.store.list()).items[0];
  const raw = JSON.parse(await readFile(f.path, "utf8"));
  raw.items[0].createdAt -= 1;
  await writeFile(f.path, JSON.stringify(raw));
  await f.store.ingestIssues(Array.from({ length: 1000 }, (_, i) => occurrence(`other-${i}`, f.now(), {
    grouping: { source: "adapter", cause: `other-${i}`, remediationTarget: "other" },
  })));
  expect(await f.store.get(original.id)).toBeNull();
  expect((await f.store.list({ limit: 1 })).unreadErrorCount).toBe(1000);
  await f.store.ingestIssues([occurrence("first", f.now())]);
  f.advance(1);
  await f.store.ingestIssues([occurrence("new-real", f.now())]);
  const renewed = (await f.store.list()).items.find((item) => item.issue?.groupKey === original.issue?.groupKey)!;
  expect(renewed.id).not.toBe(original.id);
  expect(renewed.issue?.occurrenceCount).toBe(1);
  await f.store.markRead({ ids: [original.id], read: true, observedIssues: [{ id: original.id, occurrenceCount: 1 }] });
  expect((await f.store.get(renewed.id))?.readAt).toBeNull();
  f.advance(NOTIFICATION_RETENTION_MS);
  expect((await f.store.list()).items).toHaveLength(0);
});

test("10k receipt cap persists a monotonic floor: drops delayed real events below it and accepts out-of-order above it", async () => {
  const f = await fixture();
  const start = f.now() - 20_000;
  await f.store.ingestIssues(Array.from({ length: 10_000 }, (_, i) => occurrence(`event-${i}`, start + i * 2)));
  await f.store.ingestIssues([occurrence("newest", f.now())]);
  const stored = JSON.parse(await readFile(f.path, "utf8"));
  expect(stored.issues.receipts).toHaveLength(10_000);
  expect(stored.issues.floor.occurredAt).toBe(start);
  expect(await f.open().ingestIssues([occurrence("event-0", start), occurrence("unknown-late", start - 1)])).toEqual({ accepted: 0, rejected: 2, duplicate: 0 });
  expect(await f.store.ingestIssues([occurrence("out-of-order", start + 1)])).toEqual({ accepted: 1, rejected: 0, duplicate: 0 });
  const page = await f.store.list();
  expect(page.issueCoverage).toMatchObject({ receiptLimit: 10_000, rejectedCount: 2, admissionFloor: { occurredAt: start + 1 } });
  const before = f.writes.length;
  await f.store.list();
  expect(f.writes).toHaveLength(before);
  const started = performance.now();
  for (let i = 0; i < 20; i++) await f.store.list({ limit: 1 });
  const elapsed = performance.now() - started;
  expect(f.writes).toHaveLength(before);
  console.info(`Issue retention measurement: 10000 receipts, ${Buffer.byteLength(await readFile(f.path, "utf8"))} full-store serialized bytes.`);
  console.info(`Issue retained-store reads: 20 reads at 10000 receipts in ${elapsed.toFixed(1)} ms; 0 writes.`);
});

test("independent store instances serialize overlapping receipt/counter commits without losing an occurrence", async () => {
  const f = await fixture();
  await Promise.all([
    f.store.ingestIssues([occurrence("shared", f.now()), occurrence("a", f.now())]),
    f.open().ingestIssues([occurrence("shared", f.now()), occurrence("b", f.now())]),
  ]);
  expect((await f.open().list()).items[0].issue?.occurrenceCount).toBe(3);
  expect(JSON.parse(await readFile(f.path, "utf8")).issues.receipts).toHaveLength(3);
});

test("TTL advances floor only for removed receipts and cannot be reset by restart or old unseen events", async () => {
  const f = await fixture();
  const originalTime = f.now();
  await f.store.ingestIssues([occurrence("a", originalTime)]);
  f.advance(NOTIFICATION_RETENTION_MS);
  const page = await f.open().list();
  expect(page.items).toHaveLength(0);
  expect(page.issueCoverage.admissionFloor?.occurredAt).toBe(originalTime);
  const writes = f.writes.length;
  f.advance(1);
  await f.store.list();
  expect(f.writes).toHaveLength(writes);
  expect(await f.store.ingestIssues([occurrence("old-unknown", originalTime), occurrence("new", f.now())])).toEqual({ accepted: 1, rejected: 1, duplicate: 0 });
  expect((await f.store.list()).items[0].issue?.occurrenceCount).toBe(1);
});

test("delayed creation uses original source time and recurrence never extends group age", async () => {
  const f = await fixture();
  const originalTime = f.now() - NOTIFICATION_RETENTION_MS + 100;
  await f.store.ingestIssues([occurrence("delayed", originalTime)]);
  const first = (await f.store.list()).items[0];
  expect(first.createdAt).toBe(originalTime);
  await f.store.ingestIssues([occurrence("current", f.now())]);
  expect((await f.store.list()).items[0]).toMatchObject({ id: first.id, createdAt: originalTime, issue: { occurrenceCount: 2 } });
  f.advance(100);
  expect((await f.store.list()).items).toHaveLength(0);
});

test("group identity canonicalizes config order and separates remediation targets, profiles and namespaces", async () => {
  const f = await fixture();
  const first = occurrence("same", f.now());
  first.grouping.configuration = { a: 1, b: true };
  await f.store.ingestIssues([first, { ...first, namespace: "another-source", grouping: { ...first.grouping, configuration: { b: true, a: 1 } } },
    { ...first, occurrenceId: "different-target", grouping: { ...first.grouping, remediationTarget: "other" } },
    { ...first, occurrenceId: "different-profile", grouping: { ...first.grouping, profile: "other" } }]);
  expect((await f.store.list()).items.map((item) => item.issue!.occurrenceCount).sort()).toEqual([1, 1, 2]);
});

test("error severity cannot be stored with implicit native delivery policy", async () => {
  const f = await fixture();
  expect(() => f.store.upsert({ id: "error", kind: "failure", severity: "error", title: "Error", body: "Review the failure.",
    createdAt: f.now(), readAt: null, environmentId: "dev", sessionId: "session", sourceUrl: "/chat?environment=dev&session=session",
    delivery: { status: "pending" } })).toThrow("Invalid notification");
});
