import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { SPARK_SESSION_ID } from "../../sessions/spark-session.js";
import { createSparkSessionClearBoundary } from "../session/spark-session-clear.js";
import { createSparkClearFixture } from "./support/spark-clear-fixture.js";

const fixtures: Awaited<ReturnType<typeof createSparkClearFixture>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});
async function fixture() {
  const created = await createSparkClearFixture(); fixtures.push(created); return created;
}

test("failed cleanup keeps exact references across owner restart and explicit clear retry", async () => {
  const f = await fixture();
  const old = await f.attach();
  vi.spyOn(f.attachments, "deleteAttachment").mockRejectedValueOnce(new Error("cleanup_failed"));
  await expect(f.sessions.clearSessionMessages(SPARK_SESSION_ID)).rejects.toThrow("cleanup_failed");
  expect((await f.sessions.getSessionById(SPARK_SESSION_ID))?.messages).toEqual([]);
  expect(JSON.parse(await readFile(f.receiptPath, "utf8")).references).toEqual([old]);
  if (process.platform !== "win32") expect((await stat(f.receiptPath)).mode & 0o777).toBe(0o600);
  const restarted = f.restart();
  await restarted.sessions.clearSessionMessages(SPARK_SESSION_ID);
  await expect(f.attachments.resolveAttachment(old)).rejects.toThrow();
  await expect(readFile(f.receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
  await restarted.sessions.clearSessionMessages(SPARK_SESSION_ID);
  expect(f.attachments.deleteAttachment).toHaveBeenCalledTimes(2);
});

test("partial deletion retains every reference and retry preserves uploads absent from the cleared transcript", async () => {
  const f = await fixture();
  const first = await f.attach("first"); const second = await f.attach("second");
  const remove = f.attachments.deleteAttachment!.bind(f.attachments);
  vi.spyOn(f.attachments, "deleteAttachment").mockImplementationOnce(remove)
    .mockRejectedValueOnce(new Error("partial_cleanup_failed"));
  await expect(f.sessions.clearSessionMessages(SPARK_SESSION_ID)).rejects.toThrow("partial_cleanup_failed");
  await expect(f.attachments.resolveAttachment(first)).rejects.toThrow();
  await expect(f.attachments.resolveAttachment(second)).resolves.toBeDefined();
  const fresh = await f.attachments.saveAttachment({ sessionId: SPARK_SESSION_ID, requestId: "fresh",
    kind: "file", mimeType: "text/plain", bytes: Buffer.from("fresh") });
  expect(JSON.parse(await readFile(f.receiptPath, "utf8")).references).toEqual([first, second]);
  await f.restart().sessions.clearSessionMessages(SPARK_SESSION_ID);
  await expect(f.attachments.resolveAttachment(second)).rejects.toThrow();
  await expect(f.attachments.resolveAttachment(fresh)).resolves.toBeDefined();
});

test("receipt write failure leaves the transcript and original attachment untouched", async () => {
  const f = await fixture(); const old = await f.attach();
  await writeFile(join(f.directory, "spark-chat"), "blocks directory creation");
  const before = await f.sessions.getSessionById(SPARK_SESSION_ID);
  await expect(f.sessions.clearSessionMessages(SPARK_SESSION_ID)).rejects.toThrow();
  expect(await f.sessions.getSessionById(SPARK_SESSION_ID)).toEqual(before);
  await expect(f.attachments.resolveAttachment(old)).resolves.toBeDefined();
});

test("a failed transcript commit deletes nothing and its receipt is safe to retry", async () => {
  const f = await fixture(); const old = await f.attach();
  const before = await f.sessions.getSessionById(SPARK_SESSION_ID);
  const remove = vi.spyOn(f.attachments, "deleteAttachment");
  const boundary = createSparkSessionClearBoundary(f.backing, () => f.admission, f.attachments, f.directory);
  await expect(boundary(SPARK_SESSION_ID, async () => { throw new Error("clear_failed"); })).rejects.toThrow("clear_failed");
  expect(remove).not.toHaveBeenCalled();
  expect(await f.sessions.getSessionById(SPARK_SESSION_ID)).toEqual(before);
  await expect(f.attachments.resolveAttachment(old)).resolves.toBeDefined();
  await f.sessions.clearSessionMessages(SPARK_SESSION_ID);
  await expect(f.attachments.resolveAttachment(old)).rejects.toThrow();
});

test("invalid cleanup receipts fail closed without clearing history or deleting files", async () => {
  const f = await fixture(); const old = await f.attach();
  await mkdir(dirname(f.receiptPath), { recursive: true });
  await writeFile(f.receiptPath, JSON.stringify({ schemaVersion: 1, sessionId: "another-session", references: [old] }));
  const before = await f.sessions.getSessionById(SPARK_SESSION_ID);
  await expect(f.sessions.clearSessionMessages(SPARK_SESSION_ID)).rejects.toThrow("spark_chat_cleanup_receipt_invalid");
  expect(await f.sessions.getSessionById(SPARK_SESSION_ID)).toEqual(before);
  await expect(f.attachments.resolveAttachment(old)).resolves.toBeDefined();
});
