import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import { createFileAttachmentStore } from "../attachments/store.js";
import { deleteSessionWithAttachments } from "../session/session-attachment-deletion.js";

function gate() {
  let open!: () => void;
  const waiting = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { waiting, open };
}

test("an accepted duplicate deletion cannot remove a reused raw session after the first success", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "attachment-overlap-"));
  const sessions = createInMemorySessionStore();
  const attachments = createFileAttachmentStore({ attachmentsDir: rootDir });
  const sessionId = "reused";
  const originalDelete = sessions.deleteSessionWithStats.bind(sessions);
  const duplicatePhysical = gate();
  const firstCleanup = gate();
  let physicalCalls = 0;
  const physical = vi
    .spyOn(sessions, "deleteSessionWithStats")
    .mockImplementation(async (id) => {
      physicalCalls += 1;
      // An erroneous second physical attempt must not reach the new lifetime.
      if (physicalCalls === 2) await duplicatePhysical.waiting;
      return originalDelete(id);
    });
  const originalCleanup =
    attachments.deleteSessionAttachments.bind(attachments);
  const cleanup = vi
    .spyOn(attachments, "deleteSessionAttachments")
    .mockImplementationOnce(async (id) => {
      await firstCleanup.waiting;
      return originalCleanup(id);
    });
  const calls: Promise<unknown>[] = [];

  async function saveAttachment(name: string) {
    const attachment = await attachments.saveAttachment({
      sessionId,
      requestId: name,
      kind: "file",
      mimeType: "text/plain",
      bytes: Buffer.from(name),
      name: `${name}.txt`,
    });
    return (await attachments.resolveAttachment(attachment)).absolutePath;
  }

  try {
    await sessions.appendMessage(sessionId, "user", "old question");
    await sessions.startRequestStream(sessionId, "old-request");
    const oldAttachment = await saveAttachment("old");
    const first = deleteSessionWithAttachments(
      sessions,
      attachments,
      sessionId,
    );
    calls.push(first);
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
    const duplicate = deleteSessionWithAttachments(
      sessions,
      attachments,
      sessionId,
    );
    calls.push(duplicate);
    firstCleanup.open();
    expect(await first).toEqual({
      sessionId,
      deleted: true,
      deletedMessages: 1,
      deletedRequests: 1,
    });

    await sessions.appendMessage(sessionId, "user", "new question");
    const newAttachment = await saveAttachment("new");
    duplicatePhysical.open();
    const duplicateReceipt = await duplicate;
    expect(await sessions.getSessionById(sessionId)).not.toBeNull();
    expect(await readFile(newAttachment, "utf8")).toBe("new");
    expect(duplicateReceipt).toEqual({
      sessionId,
      deleted: false,
      deletedMessages: 0,
      deletedRequests: 0,
    });
    expect(physical).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    await expect(readFile(oldAttachment)).rejects.toMatchObject({
      code: "ENOENT",
    });

    await expect(
      deleteSessionWithAttachments(sessions, attachments, sessionId),
    ).resolves.toEqual({
      sessionId,
      deleted: true,
      deletedMessages: 1,
      deletedRequests: 0,
    });
    expect(physical).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledTimes(2);
    await expect(readFile(newAttachment)).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    firstCleanup.open();
    duplicatePhysical.open();
    await Promise.allSettled(calls);
    vi.restoreAllMocks();
    await rm(rootDir, { recursive: true, force: true });
  }
});
