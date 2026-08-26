import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  createFileAttachmentStore,
  parseRuntimeAttachmentReferences,
} from "../attachments/store.js";

const tempRoots: string[] = [];

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "llm-runtime-attachments-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("runtime attachments", () => {
  test("stores image bytes and validates persisted references", async () => {
    const root = await createTempRoot();
    const store = createFileAttachmentStore({
      attachmentsDir: join(root, "attachments"),
    });

    const saved = await store.saveAttachment({
      sessionId: "session-1",
      requestId: "request-1",
      kind: "image",
      mimeType: "image/png",
      name: "screen.png",
      bytes: new Uint8Array([137, 80, 78, 71]),
    });

    expect(saved).toMatchObject({
      kind: "image",
      mimeType: "image/png",
      name: "screen.png",
      size: 4,
    });
    expect(saved.storageRef).toContain("session-1/request-1/");

    const [validated] = await store.validateAttachmentReferences([saved]);
    expect(validated).toEqual(saved);
    const [sessionValidated] = await store.validateAttachmentReferences(
      [saved],
      { sessionId: "session-1" },
    );
    expect(sessionValidated).toEqual(saved);
    await expect(
      store.validateAttachmentReferences([saved], { sessionId: "session-2" }),
    ).rejects.toThrow("attachment_session_mismatch");

    const resolved = await store.resolveAttachment(saved);
    expect(resolved.metadata).toEqual(saved);
    expect(resolved.absolutePath).toContain(join("attachments", "session-1"));
    await store.deleteSessionAttachments("session-1");
    await expect(readFile(resolved.absolutePath)).rejects.toThrow();
  });

  test("stores supported document bytes without treating them as images", async () => {
    const root = await createTempRoot();
    const store = createFileAttachmentStore({
      attachmentsDir: join(root, "attachments"),
    });

    const saved = await store.saveAttachment({
      sessionId: "session-doc",
      requestId: "request-doc",
      kind: "file",
      mimeType: "application/pdf; charset=binary",
      name: "brief.pdf",
      bytes: new Uint8Array([37, 80, 68, 70]),
    });

    expect(saved).toMatchObject({
      kind: "file",
      mimeType: "application/pdf",
      name: "brief.pdf",
      size: 4,
    });
    expect(saved.storageRef).toMatch(/\.pdf$/u);
    await expect(
      store.saveAttachment({
        sessionId: "session-doc",
        requestId: "request-doc",
        kind: "image",
        mimeType: "application/pdf",
        bytes: new Uint8Array([1]),
      }),
    ).rejects.toThrow("attachment_type_unsupported");
  });

  test("checks attachment ownership after storage ref canonicalization", async () => {
    const root = await createTempRoot();
    const store = createFileAttachmentStore({
      attachmentsDir: join(root, "attachments"),
    });
    const saved = await store.saveAttachment({
      sessionId: "session-b",
      requestId: "request-1",
      kind: "image",
      mimeType: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
    });

    await expect(
      store.validateAttachmentReferences(
        [
          {
            ...saved,
            storageRef: saved.storageRef.replace(
              "session-b/",
              "session-a/../session-b/",
            ),
          },
        ],
        { sessionId: "session-a" },
      ),
    ).rejects.toThrow("attachment_session_mismatch");
  });

  test("rejects dot owner segments before creating storage refs", async () => {
    const root = await createTempRoot();
    const store = createFileAttachmentStore({
      attachmentsDir: join(root, "attachments"),
    });

    await expect(
      store.saveAttachment({
        sessionId: "session-1",
        requestId: "..",
        kind: "image",
        mimeType: "image/png",
        bytes: new Uint8Array([1, 2, 3]),
      }),
    ).rejects.toThrow("attachment_owner_invalid");
    await expect(store.deleteSessionAttachments(".")).rejects.toThrow(
      "attachment_owner_invalid",
    );
  });

  test("accepts references only and rejects inline payloads", () => {
    expect(() =>
      parseRuntimeAttachmentReferences([
        {
          id: "att-inline",
          kind: "image",
          mimeType: "image/png",
          storageRef: "session/request/att-inline.png",
          base64: "iVBORw0KGgo=",
        },
      ]),
    ).toThrow("attachment_inline_payload_unsupported");
  });

  test("parses supported file references and rejects kind mismatches", () => {
    expect(
      parseRuntimeAttachmentReferences([
        {
          id: "att-doc",
          kind: "file",
          mimeType: "application/pdf",
          storageRef: "session/request/att-doc.pdf",
        },
      ]),
    ).toEqual([
      {
        id: "att-doc",
        kind: "file",
        mimeType: "application/pdf",
        storageRef: "session/request/att-doc.pdf",
      },
    ]);
    expect(() =>
      parseRuntimeAttachmentReferences([
        {
          id: "att-doc",
          kind: "image",
          mimeType: "application/pdf",
          storageRef: "session/request/att-doc.pdf",
        },
      ]),
    ).toThrow("attachment_mime_unsupported");
  });
});
