import { beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  clearSessionMessages: vi.fn(),
  deleteMessageWithStats: vi.fn(),
  deleteSessionWithStats: vi.fn(),
  getRequestReplayById: vi.fn(),
  getSessionSnapshot: vi.fn(),
  listSessions: vi.fn(),
  saveAttachment: vi.fn(),
  resolveAttachment: vi.fn(),
  validateAttachmentReferences: vi.fn(),
  deleteSessionAttachments: vi.fn(),
  deleteAttachment: vi.fn(),
}));

vi.mock("../../sessions/index.js", () => ({
  clearSessionMessages: mocks.clearSessionMessages,
  deleteMessageWithStats: mocks.deleteMessageWithStats,
  deleteSessionWithStats: mocks.deleteSessionWithStats,
  getRequestReplayById: mocks.getRequestReplayById,
  getSessionSnapshot: mocks.getSessionSnapshot,
  listSessions: mocks.listSessions,
}));

import { handleRuntimeReplayBridgeMessage } from "../../bridge/runtime-replay.js";

function createMockWebSocket() {
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    ws: {
      send(message: string) {
        sent.push(JSON.parse(message) as Record<string, unknown>);
      },
    },
  };
}

describe("runtime replay bridge handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("ignores unrelated bridge messages", async () => {
    const { ws, sent } = createMockWebSocket();

    const handled = await handleRuntimeReplayBridgeMessage(ws as never, {
      type: "run_request",
    });

    expect(handled).toBe(false);
    expect(sent).toEqual([]);
  });

  test("responds with request event replay", async () => {
    mocks.getRequestReplayById.mockResolvedValueOnce({
      requestId: "req-1",
      sessionId: "sess-1",
      events: [
        {
          type: "completed",
          requestId: "req-1",
          seqNo: 2,
          timestamp: 1770000000000,
          output: "Done.",
        },
      ],
      finalState: {
        status: "completed",
        output: "Done.",
        completedAt: 1770000000000,
      },
    });
    const { ws, sent } = createMockWebSocket();

    const handled = await handleRuntimeReplayBridgeMessage(ws as never, {
      type: "request.events.request",
      correlationId: "corr-1",
      requestId: "req-1",
      afterSeq: 1,
    });

    expect(handled).toBe(true);
    expect(mocks.getRequestReplayById).toHaveBeenCalledWith("req-1", 1);
    expect(sent).toEqual([
      {
        type: "request.events.response",
        correlationId: "corr-1",
        ok: true,
        requestId: "req-1",
        events: [
          {
            type: "completed",
            requestId: "req-1",
            seqNo: 2,
            timestamp: 1770000000000,
            output: "Done.",
          },
        ],
        finalState: {
          status: "completed",
          output: "Done.",
          completedAt: 1770000000000,
        },
      },
    ]);
  });

  test("responds with failure when request replay is missing", async () => {
    mocks.getRequestReplayById.mockResolvedValueOnce(null);
    const { ws, sent } = createMockWebSocket();

    const handled = await handleRuntimeReplayBridgeMessage(ws as never, {
      type: "request.events.request",
      correlationId: "corr-2",
      requestId: "req-missing",
    });

    expect(handled).toBe(true);
    expect(sent).toEqual([
      {
        type: "request.events.response",
        correlationId: "corr-2",
        ok: false,
        requestId: "req-missing",
        events: [],
        finalState: null,
        error: "request events not found",
      },
    ]);
  });

  test("responds with session list", async () => {
    mocks.listSessions.mockResolvedValueOnce({
      sessions: [{ id: "sess-1", title: "sess-1" }],
      nextCursor: null,
    });
    const { ws, sent } = createMockWebSocket();

    const handled = await handleRuntimeReplayBridgeMessage(ws as never, {
      type: "session.list.request",
      correlationId: "corr-list",
      limit: 50,
      cursor: "10",
    });

    expect(handled).toBe(true);
    expect(mocks.listSessions).toHaveBeenCalledWith({
      limit: 50,
      cursor: "10",
    });
    expect(sent).toEqual([
      {
        type: "session.list.response",
        correlationId: "corr-list",
        ok: true,
        sessions: [{ id: "sess-1", title: "sess-1" }],
        nextCursor: null,
      },
    ]);
  });

  test("responds with session snapshot", async () => {
    mocks.getSessionSnapshot.mockResolvedValueOnce({
      sessionId: "sess-1",
      messages: [{ id: 1, text: "hello" }],
      requests: [{ requestId: "req-1" }],
      nextCursor: null,
    });
    const { ws, sent } = createMockWebSocket();

    const handled = await handleRuntimeReplayBridgeMessage(ws as never, {
      type: "session.snapshot.request",
      correlationId: "corr-snapshot",
      sessionId: "sess-1",
      afterMessageId: 3,
      includeRequests: true,
    });

    expect(handled).toBe(true);
    expect(mocks.getSessionSnapshot).toHaveBeenCalledWith("sess-1", {
      afterMessageId: 3,
      includeRequests: true,
    });
    expect(sent).toEqual([
      {
        type: "session.snapshot.response",
        correlationId: "corr-snapshot",
        ok: true,
        sessionId: "sess-1",
        messages: [{ id: 1, text: "hello" }],
        requests: [{ requestId: "req-1" }],
        nextCursor: null,
      },
    ]);
  });

  test("responds with session mutation results", async () => {
    mocks.deleteSessionWithStats.mockResolvedValueOnce({
      sessionId: "sess-1",
      deleted: true,
      deletedMessages: 2,
      deletedRequests: 1,
    });
    mocks.clearSessionMessages.mockResolvedValueOnce({
      sessionId: "sess-2",
      cleared: true,
      deletedMessages: 3,
      deletedRequests: 2,
      updatedAt: 1770000000000,
    });
    mocks.deleteMessageWithStats.mockResolvedValueOnce({
      sessionId: "sess-3",
      messageId: "msg-4",
      deleted: true,
      updatedAt: 1770000000001,
      deletedRequestId: "req-4",
      deletedRequestEvents: 8,
    });
    mocks.getSessionSnapshot.mockResolvedValueOnce({
      sessionId: "sess-3",
      messages: [
        {
          id: 4,
          role: "user",
          text: "image",
          attachments: [
            {
              id: "att-4",
              kind: "image",
              mimeType: "image/png",
              storageRef: "sess-3/req-4/att-4.png",
              size: 4,
            },
          ],
        },
      ],
      requests: [],
      nextCursor: null,
    });
    mocks.getSessionSnapshot.mockResolvedValueOnce({
      sessionId: "sess-3",
      messages: [],
      requests: [],
      nextCursor: null,
    });
    const { ws, sent } = createMockWebSocket();
    const attachmentStore = {
      saveAttachment: mocks.saveAttachment,
      validateAttachmentReferences: mocks.validateAttachmentReferences,
      resolveAttachment: mocks.resolveAttachment,
      deleteAttachment: mocks.deleteAttachment,
      deleteSessionAttachments: mocks.deleteSessionAttachments,
    };

    expect(
      await handleRuntimeReplayBridgeMessage(
        ws as never,
        {
          type: "session.delete.request",
          correlationId: "corr-delete",
          sessionId: "sess-1",
        },
        { attachmentStore },
      ),
    ).toBe(true);
    expect(
      await handleRuntimeReplayBridgeMessage(
        ws as never,
        {
          type: "session.messages.clear.request",
          correlationId: "corr-clear",
          sessionId: "sess-2",
        },
        { attachmentStore },
      ),
    ).toBe(true);
    expect(
      await handleRuntimeReplayBridgeMessage(
        ws as never,
        {
          type: "session.message.delete.request",
          correlationId: "corr-message-delete",
          sessionId: "sess-3",
          messageId: "msg-4",
        },
        { attachmentStore },
      ),
    ).toBe(true);

    expect(sent).toEqual([
      {
        type: "session.delete.response",
        correlationId: "corr-delete",
        ok: true,
        sessionId: "sess-1",
        deleted: true,
        deletedMessages: 2,
        deletedRequests: 1,
      },
      {
        type: "session.messages.clear.response",
        correlationId: "corr-clear",
        ok: true,
        sessionId: "sess-2",
        cleared: true,
        deletedMessages: 3,
        deletedRequests: 2,
        updatedAt: 1770000000000,
      },
      {
        type: "session.message.delete.response",
        correlationId: "corr-message-delete",
        ok: true,
        sessionId: "sess-3",
        messageId: "msg-4",
        deleted: true,
        updatedAt: 1770000000001,
        deletedRequestId: "req-4",
        deletedRequestEvents: 8,
      },
    ]);
    expect(mocks.deleteSessionAttachments).toHaveBeenCalledWith("sess-1");
    expect(mocks.deleteSessionAttachments).toHaveBeenCalledWith("sess-2");
    expect(mocks.deleteAttachment).toHaveBeenCalledWith(
      {
        id: "att-4",
        kind: "image",
        mimeType: "image/png",
        storageRef: "sess-3/req-4/att-4.png",
        size: 4,
      },
      { sessionId: "sess-3" },
    );
  });

  test("keeps message attachments that are still referenced after deletion", async () => {
    mocks.deleteMessageWithStats.mockResolvedValueOnce({
      sessionId: "sess-shared",
      messageId: "1",
      deleted: true,
      updatedAt: 1770000000002,
    });
    mocks.getSessionSnapshot
      .mockResolvedValueOnce({
        sessionId: "sess-shared",
        messages: [
          {
            id: "1",
            attachments: [
              {
                id: "att-shared",
                kind: "image",
                mimeType: "image/png",
                storageRef: "sess-shared/req-1/att-shared.png",
              },
              {
                id: "att-private",
                kind: "image",
                mimeType: "image/png",
                storageRef: "sess-shared/req-1/att-private.png",
              },
            ],
          },
        ],
        requests: [],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        sessionId: "sess-shared",
        messages: [
          {
            id: "2",
            attachments: [
              {
                id: "att-shared",
                kind: "image",
                mimeType: "image/png",
                storageRef: "sess-shared/req-1/att-shared.png",
              },
            ],
          },
        ],
        requests: [],
        nextCursor: null,
      });
    const { ws } = createMockWebSocket();
    const attachmentStore = {
      saveAttachment: mocks.saveAttachment,
      validateAttachmentReferences: mocks.validateAttachmentReferences,
      resolveAttachment: mocks.resolveAttachment,
      deleteAttachment: mocks.deleteAttachment,
      deleteSessionAttachments: mocks.deleteSessionAttachments,
    };

    const handled = await handleRuntimeReplayBridgeMessage(
      ws as never,
      {
        type: "session.message.delete.request",
        correlationId: "corr-shared-delete",
        sessionId: "sess-shared",
        messageId: "1",
      },
      { attachmentStore },
    );

    expect(handled).toBe(true);
    expect(mocks.deleteAttachment).toHaveBeenCalledTimes(1);
    expect(mocks.deleteAttachment).toHaveBeenCalledWith(
      {
        id: "att-private",
        kind: "image",
        mimeType: "image/png",
        storageRef: "sess-shared/req-1/att-private.png",
      },
      { sessionId: "sess-shared" },
    );
  });

  test("responds with attachment upload result", async () => {
    mocks.saveAttachment.mockResolvedValueOnce({
      id: "att-1",
      kind: "image",
      mimeType: "image/png",
      storageRef: "sess-1/corr-upload/att-1.png",
      name: "photo.png",
      size: 5,
    });
    const { ws, sent } = createMockWebSocket();

    const handled = await handleRuntimeReplayBridgeMessage(
      ws as never,
      {
        type: "attachment.upload.request",
        correlationId: "corr-upload",
        sessionId: "sess-1",
        requestId: "req-upload",
        mimeType: "image/png",
        name: "photo.png",
        data: Buffer.from("image").toString("base64"),
      },
      {
        attachmentStore: {
          saveAttachment: mocks.saveAttachment,
          validateAttachmentReferences: vi.fn(),
          resolveAttachment: vi.fn(),
          deleteSessionAttachments: vi.fn(),
        },
      },
    );

    expect(handled).toBe(true);
    expect(mocks.saveAttachment).toHaveBeenCalledWith({
      sessionId: "sess-1",
      requestId: "req-upload",
      kind: "image",
      mimeType: "image/png",
      bytes: Buffer.from("image"),
      name: "photo.png",
    });
    expect(sent).toEqual([
      {
        type: "attachment.upload.response",
        correlationId: "corr-upload",
        ok: true,
        sessionId: "sess-1",
        attachment: {
          id: "att-1",
          kind: "image",
          mimeType: "image/png",
          storageRef: "sess-1/corr-upload/att-1.png",
          name: "photo.png",
          size: 5,
        },
      },
    ]);
  });

  test("infers file kind for a supported document upload", async () => {
    mocks.saveAttachment.mockResolvedValueOnce({
      id: "att-doc",
      kind: "file",
      mimeType: "application/pdf",
      storageRef: "sess-doc/req-doc/att-doc.pdf",
      name: "brief.pdf",
      size: 4,
    });
    const { ws, sent } = createMockWebSocket();

    const handled = await handleRuntimeReplayBridgeMessage(
      ws as never,
      {
        type: "attachment.upload.request",
        correlationId: "corr-doc",
        sessionId: "sess-doc",
        requestId: "req-doc",
        mimeType: "application/pdf",
        name: "brief.pdf",
        data: Buffer.from("%PDF").toString("base64"),
      },
      {
        attachmentStore: {
          saveAttachment: mocks.saveAttachment,
          validateAttachmentReferences: vi.fn(),
          resolveAttachment: vi.fn(),
          deleteSessionAttachments: vi.fn(),
        },
      },
    );

    expect(handled).toBe(true);
    expect(mocks.saveAttachment).toHaveBeenCalledWith({
      sessionId: "sess-doc",
      requestId: "req-doc",
      kind: "file",
      mimeType: "application/pdf",
      bytes: Buffer.from("%PDF"),
      name: "brief.pdf",
    });
    expect(sent[0]).toMatchObject({
      ok: true,
      attachment: { kind: "file", mimeType: "application/pdf" },
    });
  });

  test("responds with attachment fetch data", async () => {
    const root = await mkdtemp(join(tmpdir(), "abot-attachment-fetch-"));
    const imagePath = join(root, "att-1.png");
    await writeFile(imagePath, Buffer.from("image"));
    const attachment = {
      id: "att-1",
      kind: "image" as const,
      mimeType: "image/png",
      storageRef: "sess-1/corr-upload/att-1.png",
      name: "photo.png",
      size: 5,
    };
    mocks.validateAttachmentReferences.mockResolvedValueOnce([attachment]);
    mocks.resolveAttachment.mockResolvedValueOnce({
      metadata: attachment,
      absolutePath: imagePath,
    });
    const { ws, sent } = createMockWebSocket();

    try {
      const handled = await handleRuntimeReplayBridgeMessage(
        ws as never,
        {
          type: "attachment.fetch.request",
          correlationId: "corr-fetch",
          sessionId: "sess-1",
          attachment,
        },
        {
          attachmentStore: {
            saveAttachment: mocks.saveAttachment,
            validateAttachmentReferences: mocks.validateAttachmentReferences,
            resolveAttachment: mocks.resolveAttachment,
            deleteSessionAttachments: vi.fn(),
          },
        },
      );

      expect(handled).toBe(true);
      expect(mocks.validateAttachmentReferences).toHaveBeenCalledWith(
        [attachment],
        { sessionId: "sess-1" },
      );
      expect(mocks.resolveAttachment).toHaveBeenCalledWith(attachment);
      expect(sent).toEqual([
        {
          type: "attachment.fetch.response",
          correlationId: "corr-fetch",
          ok: true,
          sessionId: "sess-1",
          attachment,
          data: Buffer.from("image").toString("base64"),
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
