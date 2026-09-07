import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createFileAttachmentStore } from "../attachments/store.js";
import {
  createNativeSessionHttpFixture,
  type NativeSessionHttpFixture,
} from "./support/web-ui-native-session-http.js";

type ReadState = {
  readStateStatus: "available" | "unavailable";
  unreadCount: number | null;
  hasUnread: boolean | null;
  lastReadAt: number | null;
  lastReadMessageId: string | null;
};
type SessionList = {
  sessions: Array<ReadState & { id: string; lastMessagePreview: string }>;
};
type Snapshot = { messages: Array<{ text: string }>; readState: ReadState };
const fixtures: NativeSessionHttpFixture[] = [];
const unavailableReadState = {
  readStateStatus: "unavailable",
  unreadCount: null,
  hasUnread: null,
  lastReadAt: null,
  lastReadMessageId: null,
};
const malformedSidecar = "{ malformed read state";

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

async function body<T>(response: Response, expectedStatus = 200): Promise<T> {
  const value = await response.json();
  expect(response.status, JSON.stringify(value)).toBe(expectedStatus);
  return value as T;
}

async function expectFailed(response: Response): Promise<void> {
  expect(await body(response, 500)).toMatchObject({
    ok: false,
    error: expect.any(String),
  });
}

async function seededFixture() {
  const fixture = await createNativeSessionHttpFixture();
  fixtures.push(fixture);
  await fixture.sessions().appendMessage("conversation", "user", "Question");
  const initial = await body<SessionList>(await fixture.request("GET"));
  fixture.timestamp(initial.sessions[0]!.lastReadAt! + 1000);
  await fixture
    .sessions()
    .appendMessage("conversation", "assistant", "Answer", {
      requestId: "reply-request",
    });
  const directory = join(fixture.paths().runtimeDir, "web-ui", "read-state");
  const sidecars = (await readdir(directory)).filter((name) =>
    name.endsWith(".json"),
  );
  expect(sidecars).toHaveLength(1);
  return { fixture, sidecar: join(directory, sidecars[0]!) };
}

async function expectReadableWithUnavailableState(
  fixture: NativeSessionHttpFixture,
): Promise<void> {
  const list = await body<SessionList>(await fixture.request("GET"));
  expect(list.sessions).toHaveLength(1);
  expect(list.sessions[0]).toMatchObject({
    id: "conversation",
    lastMessagePreview: "Answer",
    ...unavailableReadState,
  });
  const snapshot = await body<Snapshot>(
    await fixture.request("GET", "/conversation/messages"),
  );
  expect(snapshot.messages.map((message) => message.text)).toEqual([
    "Question",
    "Answer",
  ]);
  expect(snapshot.readState).toMatchObject(unavailableReadState);
}

describe("native HTTP behavior when the Web UI read-state sidecar fails", () => {
  test("malformed sidecars preserve history, fail read acknowledgements, and recover explicitly", async () => {
    const { fixture, sidecar } = await seededFixture();
    const originalReadState = await readFile(sidecar, "utf8");
    const originalSession = await fixture.sessionBytes("conversation");
    await writeFile(sidecar, malformedSidecar);

    await expectReadableWithUnavailableState(fixture);
    await expectFailed(
      await fixture.request("POST", "/conversation/read", {
        readThroughMessageId: 2,
      }),
    );
    expect(await readFile(sidecar, "utf8")).toBe(malformedSidecar);
    expect(await fixture.sessionBytes("conversation")).toBe(originalSession);

    await writeFile(sidecar, originalReadState);
    const recoveredList = await body<SessionList>(await fixture.request("GET"));
    expect(recoveredList.sessions[0]).toMatchObject({
      readStateStatus: "available",
      unreadCount: 1,
      hasUnread: true,
    });
    const recoveredSnapshot = await body<Snapshot>(
      await fixture.request("GET", "/conversation/messages"),
    );
    expect(recoveredSnapshot.readState).toMatchObject({
      readStateStatus: "available",
      unreadCount: 1,
    });
    const acknowledged = await body<{ readState: ReadState }>(
      await fixture.request("POST", "/conversation/read", {
        readThroughMessageId: 2,
      }),
    );
    expect(acknowledged.readState).toMatchObject({
      readStateStatus: "available",
      unreadCount: 0,
      hasUnread: false,
    });
  });

  test.each(["directory instead of a sidecar", "file instead of its parent"])(
    "%s does not block session reads or falsely acknowledge them",
    async (failure) => {
      const { fixture, sidecar } = await seededFixture();
      if (failure === "directory instead of a sidecar") {
        await rm(sidecar);
        await mkdir(sidecar);
      } else {
        await rm(dirname(sidecar), { recursive: true });
        await writeFile(dirname(sidecar), "blocked parent directory");
      }

      await expectReadableWithUnavailableState(fixture);
      await expectFailed(
        await fixture.request("POST", "/conversation/read", {
          readThroughMessageId: 2,
        }),
      );
      expect(
        await body(await fixture.request("GET", "/missing/messages"), 404),
      ).toMatchObject({ error: "session_not_found" });
      if (failure === "directory instead of a sidecar") {
        expect((await stat(sidecar)).isDirectory()).toBe(true);
      } else {
        expect(await readFile(dirname(sidecar), "utf8")).toBe(
          "blocked parent directory",
        );
      }
    },
  );

  test.each(["clear", "delete"])(
    "%s preserves core deletion and attachment cleanup when sidecar updates fail",
    async (operation) => {
      const { fixture, sidecar } = await seededFixture();
      const attachments = createFileAttachmentStore({
        attachmentsDir: fixture.paths().attachmentsDir,
      });
      const attachment = await attachments.saveAttachment({
        sessionId: "conversation",
        requestId: "upload-request",
        kind: "file",
        mimeType: "text/plain",
        bytes: Buffer.from("An owned attachment"),
      });
      const { absolutePath } = await attachments.resolveAttachment(attachment);
      await writeFile(sidecar, malformedSidecar);

      const suffix =
        operation === "clear" ? "/conversation/messages" : "/conversation";
      expect(await body(await fixture.request("DELETE", suffix))).toMatchObject(
        {
          ok: true,
        },
      );
      await expect(readFile(absolutePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(sidecar, "utf8")).toBe(malformedSidecar);
      const remaining = await fixture.sessions().getSessionById("conversation");
      if (operation === "clear") {
        expect(remaining?.messages).toEqual([]);
        const snapshot = await body<Snapshot>(
          await fixture.request("GET", "/conversation/messages"),
        );
        expect(snapshot.messages).toEqual([]);
        expect(snapshot.readState).toMatchObject(unavailableReadState);
      } else {
        expect(remaining).toBeNull();
        expect(
          (await body<SessionList>(await fixture.request("GET"))).sessions,
        ).toEqual([]);
      }
    },
  );

  test("corrupt native session records remain failures instead of unavailable read metadata", async () => {
    const { fixture, sidecar } = await seededFixture();
    await writeFile(sidecar, malformedSidecar);
    const sessionPath = join(fixture.paths().sessionsDir, "conversation.json");
    const invalidSession = "{ malformed native session";
    await writeFile(sessionPath, invalidSession);

    await expectFailed(await fixture.request("GET"));
    await expectFailed(await fixture.request("GET", "/conversation/messages"));
    await expectFailed(
      await fixture.request("DELETE", "/conversation/messages"),
    );
    expect(await readFile(sessionPath, "utf8")).toBe(invalidSession);
    expect(await readFile(sidecar, "utf8")).toBe(malformedSidecar);
  });

  test("canonical projection errors from valid JSON are not mislabeled as unavailable read tracking", async () => {
    const { fixture, sidecar } = await seededFixture();
    const originalReadState = await readFile(sidecar, "utf8");
    const sessionPath = join(fixture.paths().sessionsDir, "conversation.json");
    const record = JSON.parse(await fixture.sessionBytes("conversation")) as {
      requests: unknown[];
      messages: Array<{ role: string; requestId?: string }>;
    };
    record.requests = [null];
    for (const message of record.messages) {
      if (message.role === "assistant") delete message.requestId;
    }
    const invalidRequestMetadata = JSON.stringify(record);
    await writeFile(sessionPath, invalidRequestMetadata);

    await expectFailed(await fixture.request("GET"));
    await expectFailed(await fixture.request("GET", "/conversation/messages"));
    expect(await readFile(sessionPath, "utf8")).toBe(invalidRequestMetadata);
    expect(await readFile(sidecar, "utf8")).toBe(originalReadState);
  });
});
