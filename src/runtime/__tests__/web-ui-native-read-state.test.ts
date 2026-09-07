import { afterEach, describe, expect, test } from "vitest";
import type { SessionListItem, SessionSnapshot } from "../../sessions/types.js";
import type { projectSessionReadState } from "../../web-ui/session-read-state/projection.js";
import {
  createNativeSessionHttpFixture,
  type NativeSessionHttpFixture,
} from "./support/web-ui-native-session-http.js";

type ReadState = ReturnType<typeof projectSessionReadState>;
type SessionList = { sessions: Array<SessionListItem & ReadState> };
type Snapshot = SessionSnapshot & { readState: ReadState };
const fixtures: NativeSessionHttpFixture[] = [];

async function fixture(): Promise<NativeSessionHttpFixture> {
  const value = await createNativeSessionHttpFixture();
  fixtures.push(value);
  return value;
}

async function successfulBody<T>(response: Response): Promise<T> {
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body as T;
}

async function list(f: NativeSessionHttpFixture, environment = "prod") {
  return successfulBody<SessionList>(
    await f.request("GET", "", undefined, environment),
  );
}

async function snapshot(
  f: NativeSessionHttpFixture,
  id: string,
  environment = "prod",
) {
  return successfulBody<Snapshot>(
    await f.request("GET", `/${id}/messages`, undefined, environment),
  );
}

async function mark(
  f: NativeSessionHttpFixture,
  id: string,
  boundary: Record<string, unknown>,
  environment = "prod",
) {
  return successfulBody<{ readState: ReadState }>(
    await f.request("POST", `/${id}/read`, boundary, environment),
  );
}

async function migrationBoundary(
  f: NativeSessionHttpFixture,
  environment = "prod",
) {
  await f.sessions(environment).getOrCreateSession("baseline");
  const result = await list(f, environment);
  const boundary = result.sessions.find(
    (session) => session.id === "baseline",
  )!.lastReadAt;
  f.timestamp(boundary + 1000);
  return boundary;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((value) => value.close()));
});

describe("native Web UI read state through real HTTP and persisted sessions", () => {
  test("migration leaves historical conversations read and keeps their full history byte-identical", async () => {
    const f = await fixture();
    const sessions = f.sessions();
    await sessions.appendMessage("history", "user", "An old question");
    await sessions.appendMessage(
      "history",
      "assistant",
      "The historical answer",
      { requestId: "old-request" },
    );
    const original = await f.sessionBytes("history");

    const summary = (await list(f)).sessions.find(
      (session) => session.id === "history",
    );
    expect(summary).toMatchObject({
      unreadCount: 0,
      hasUnread: false,
      lastMessagePreview: "The historical answer",
    });
    const loaded = await snapshot(f, "history");
    expect(loaded.messages.map((message) => message.text)).toEqual([
      "An old question",
      "The historical answer",
    ]);
    expect(loaded.messages.map((message) => message.id)).toEqual([1, 2]);
    expect(loaded.readState).toMatchObject({
      unreadCount: 0,
      latestAssistantMessageId: 2,
    });
    expect(await f.sessionBytes("history")).toBe(original);
  });

  test("a persisted Job assistant reply after the baseline appears unread without prior Web UI conversation access", async () => {
    const f = await fixture();
    await migrationBoundary(f);
    const sessions = f.sessions();
    const schedule = {
      jobId: "job-one",
      runId: "run-one",
      title: "Daily digest",
      scheduledAt: new Date().toISOString(),
      triggerType: "schedule" as const,
    };
    await sessions.appendMessage(
      "job-conversation",
      "user",
      "Create the daily digest",
      { requestId: "job-request", schedule },
    );
    await sessions.appendMessage(
      "job-conversation",
      "assistant",
      "The Job result is ready",
      { requestId: "job-request" },
    );
    await sessions.appendMessage(
      "job-conversation",
      "assistant",
      "Internal observation",
      { grounding: "tool_observation" },
    );
    const original = await f.sessionBytes("job-conversation");

    const summary = (await list(f)).sessions.find(
      (session) => session.id === "job-conversation",
    );
    expect(summary).toMatchObject({
      unreadCount: 1,
      hasUnread: true,
      latestAssistantMessageId: 2,
    });
    const loaded = await snapshot(f, "job-conversation");
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.messages[0].schedule).toMatchObject({
      jobId: "job-one",
      runId: "run-one",
    });
    expect(loaded.readState.unreadCount).toBe(1);
    expect(await f.sessionBytes("job-conversation")).toBe(original);
  });

  test("numeric and request read boundaries clear only the displayed assistant history, without rewriting session JSON", async () => {
    const f = await fixture();
    await migrationBoundary(f);
    const sessions = f.sessions();
    await sessions.appendMessage("thread", "user", "First", {
      requestId: "first",
    });
    await sessions.appendMessage("thread", "assistant", "First result", {
      requestId: "first",
    });
    await sessions.appendMessage("thread", "user", "Second", {
      requestId: "second",
    });
    await sessions.appendMessage("thread", "assistant", "Second result", {
      requestId: "second",
    });
    const original = await f.sessionBytes("thread");
    expect((await snapshot(f, "thread")).readState.unreadCount).toBe(2);

    const numeric = await mark(f, "thread", {
      readThroughMessageId: 2,
      lastReadMessageId: "2",
    });
    expect(numeric.readState).toMatchObject({
      unreadCount: 1,
      hasUnread: true,
      lastReadMessageId: "2",
    });
    const stale = await mark(f, "thread", { readThroughMessageId: 1 });
    expect(stale.readState.unreadCount).toBe(1);
    const request = await mark(f, "thread", {
      readThroughMessageId: null,
      readThroughRequestId: "second",
    });
    expect(request.readState).toMatchObject({
      unreadCount: 0,
      hasUnread: false,
      lastReadMessageId: "4",
    });
    const loaded = await snapshot(f, "thread");
    expect(loaded.messages.map((message) => message.text)).toEqual([
      "First",
      "First result",
      "Second",
      "Second result",
    ]);
    expect(
      (await list(f)).sessions.find((session) => session.id === "thread")
        ?.unreadCount,
    ).toBe(0);
    expect(await f.sessionBytes("thread")).toBe(original);
  });

  test("missing or unmatched read boundaries cannot clear unseen native replies", async () => {
    const f = await fixture();
    await migrationBoundary(f);
    await f
      .sessions()
      .appendMessage("thread", "assistant", "Still unseen", {
        requestId: "existing-request",
      });
    for (const boundary of [
      {},
      { readThroughMessageId: null },
      { readThroughMessageId: "1" },
      { readThroughMessageId: 999 },
      { readThroughRequestId: "unrelated-request" },
    ]) {
      expect((await mark(f, "thread", boundary)).readState).toMatchObject({
        unreadCount: 1,
        hasUnread: true,
        lastReadMessageId: null,
      });
    }
  });

  test("recreating the backend preserves its migration boundary, read cursor and later unread replies", async () => {
    const f = await fixture();
    const baseline = await migrationBoundary(f);
    await f
      .sessions()
      .appendMessage("thread", "assistant", "Read result", {
        requestId: "read-request",
      });
    const marked = await mark(f, "thread", { readThroughMessageId: 1 });
    f.timestamp(baseline + 2000);
    await f
      .sessions()
      .appendMessage("thread", "assistant", "Unread result", {
        requestId: "unread-request",
      });
    const original = await f.sessionBytes("thread");

    await f.recreateBackend();
    const reopened = await snapshot(f, "thread");
    expect(reopened.readState).toMatchObject({
      unreadCount: 1,
      lastReadMessageId: "1",
      lastReadAt: marked.readState.lastReadAt,
    });
    expect(
      (await list(f)).sessions.find((session) => session.id === "baseline")
        ?.lastReadAt,
    ).toBe(baseline);
    expect(reopened.messages.map((message) => message.text)).toEqual([
      "Read result",
      "Unread result",
    ]);
    await mark(f, "thread", { readThroughRequestId: "unread-request" });
    await f.recreateBackend();
    expect((await snapshot(f, "thread")).readState).toMatchObject({
      unreadCount: 0,
      lastReadMessageId: "2",
    });
    expect(await f.sessionBytes("thread")).toBe(original);
  });

  test("reading an identically named session in one environment leaves the other environment unread", async () => {
    const f = await fixture();
    const prodBaseline = await migrationBoundary(f, "prod");
    const devBaseline = await migrationBoundary(f, "dev");
    f.timestamp(Math.max(prodBaseline, devBaseline) + 1000);
    await f
      .sessions("prod")
      .appendMessage("same-session", "assistant", "Production result", {
        requestId: "same-request",
      });
    await f
      .sessions("dev")
      .appendMessage("same-session", "assistant", "Development result", {
        requestId: "same-request",
      });
    const devOriginal = await f.sessionBytes("same-session", "dev");

    await mark(
      f,
      "same-session",
      { readThroughRequestId: "same-request" },
      "prod",
    );
    expect(
      (await snapshot(f, "same-session", "prod")).readState.unreadCount,
    ).toBe(0);
    const development = await snapshot(f, "same-session", "dev");
    expect(development.readState).toMatchObject({
      unreadCount: 1,
      hasUnread: true,
      lastReadMessageId: null,
    });
    expect(development.messages[0].text).toBe("Development result");
    await f.recreateBackend();
    expect(
      (await snapshot(f, "same-session", "dev")).readState.unreadCount,
    ).toBe(1);
    expect(await f.sessionBytes("same-session", "dev")).toBe(devOriginal);
  });

  test("marking an unknown session returns 404 and does not create a conversation", async () => {
    const f = await fixture();
    const response = await f.request("POST", "/missing/read", {
      readThroughMessageId: 1,
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "session_not_found" });
    expect(await f.sessions().getSessionById("missing")).toBeNull();
  });
});
