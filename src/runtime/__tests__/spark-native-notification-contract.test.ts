import { expect, test, vi } from "vitest";
import { createNotificationSession } from "../../computer-access/companion/native-notifications.js";
import { SPARK_SESSION_ID } from "../../sessions/spark-session.js";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import { projectNotificationEvent } from "../../web-ui/notifications/event-projection.js";
import type { WebNotification } from "../../web-ui/notifications/contracts.js";

const runtimeUrl = "ws://abot-notify.localhost:5987";
const runtimeOrigin = "http://abot-notify.localhost:5987";
const sparkSource = "/home?environment=dev&spark=1";
const messageSource = sparkSource + "&message=1&messageCreatedAt=1000";

function nativeDelivery() {
  const renderer = { send: vi.fn(async () => {}), close: vi.fn() };
  const native = createNotificationSession(
    "windows",
    runtimeUrl,
    true,
    renderer,
  );
  return {
    renderer,
    submit: (url: string, item?: WebNotification) =>
      native.handlers().desktop_notification!({
        target: "windows",
        notificationId: item?.id ?? "a".repeat(64),
        title: item?.title ?? "SPARK reply",
        body: item?.body ?? "A reply is ready",
        url,
      }),
  };
}

async function canonicalConversations() {
  const sessions = createInMemorySessionStore({ now: () => new Date(1000) });
  await sessions.appendAssistantInitiative!(SPARK_SESSION_ID, {
    title: "A useful next step",
    content: "Would you like to explore this?",
    initiative: {
      kind: "proactive_proposal_v1",
      proposalId: "proposal-1",
      reason: "A saved interest",
      sources: [{ kind: "candidate", id: "interest", version: "1" }],
    },
  });
  await sessions.appendMessage(SPARK_SESSION_ID, "assistant", "Done", {
    requestId: "direct-request",
  });
  await sessions.getOrCreateSession("ordinary");
  await sessions.appendMessage("ordinary", "assistant", "Done", {
    requestId: "ordinary-request",
  });
  return {
    spark: await sessions.getSessionById(SPARK_SESSION_ID),
    ordinary: await sessions.getSessionById("ordinary"),
  };
}

const sparkEvents = [
  {
    label: "direct reply",
    event: { type: "completed", requestId: "direct-request", output: "Done" },
    source: messageSource + "&request=direct-request",
  },
  {
    label: "proactive initiative",
    event: {
      type: "learning.changed",
      event: {
        type: "proposal_delivered",
        proposalId: "proposal-1",
        sessionId: SPARK_SESSION_ID,
      },
    },
    source:
      sparkSource + "&message=initiative%3Aproposal-1&messageCreatedAt=1000",
  },
  {
    label: "approval without an assistant message",
    event: {
      type: "event",
      name: "tool.approval.required",
      requestId: "pending-request",
      approvalId: "pending-approval",
    },
    source: sparkSource,
  },
  {
    label: "approval with an assistant message",
    event: {
      type: "event",
      name: "tool.approval.required",
      requestId: "direct-request",
      approvalId: "direct-approval",
    },
    source: messageSource + "&request=direct-request",
  },
  {
    label: "failure without an assistant message",
    event: { type: "failed", requestId: "failed-request", error: "Failed" },
    source: sparkSource,
  },
];

test.each(sparkEvents)(
  "SPARK $label reaches the native renderer with its canonical source",
  async ({ event, source }) => {
    const { spark } = await canonicalConversations();
    const item = projectNotificationEvent(
      {
        ...event,
        environment: "dev",
        sessionId: SPARK_SESSION_ID,
      },
      2000,
      spark,
    )!;
    expect(item).toMatchObject({ sessionKind: "spark", sourceUrl: source });
    const native = nativeDelivery();
    const result = await native.submit(item.sourceUrl, item);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(native.renderer.send).toHaveBeenCalledExactlyOnceWith(
      {
        target: "windows",
        notificationId: item.id,
        title: item.title,
        body: item.body,
        url: runtimeOrigin + source,
      },
      undefined,
    );
  },
);

test("ordinary conversation and Automation sources retain native delivery", async () => {
  const { ordinary } = await canonicalConversations();
  const items = [
    projectNotificationEvent(
      {
        type: "completed",
        environment: "dev",
        sessionId: "ordinary",
        requestId: "ordinary-request",
        output: "Done",
      },
      2000,
      ordinary,
    )!,
    projectNotificationEvent(
      {
        type: "event",
        name: "automation.run.finished",
        environment: "dev",
        automationId: "automation-1",
        runId: "run-1",
        status: "succeeded",
      },
      2000,
    )!,
  ];
  expect(items.map((item) => item.sourceUrl)).toEqual([
    "/chat?environment=dev&session=ordinary",
    "/automations?environment=dev&automation=automation-1&run=run-1",
  ]);
  const native = nativeDelivery();
  for (const item of items) {
    expect(await native.submit(item.sourceUrl, item)).toMatchObject({
      ok: true,
    });
    expect(native.renderer.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        notificationId: item.id,
        url: runtimeOrigin + item.sourceUrl,
      }),
      undefined,
    );
  }
  expect(native.renderer.send).toHaveBeenCalledTimes(2);
});

test.each([
  "/home?environment=dev",
  "/home?environment=dev&session=ordinary",
  "/home?" +
    new URLSearchParams({
      environment: "סביבת-פיתוח",
      spark: "1",
      message: "הודעה-1",
      messageCreatedAt: "0",
      request: "בקשה-1",
    }),
  sparkSource +
    "&message=initiative%3Aproposal-1&messageCreatedAt=9007199254740991",
])("preserves supported native source %s", async (source) => {
  const native = nativeDelivery();
  expect(await native.submit(source)).toMatchObject({ ok: true });
  expect(native.renderer.send).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      url: runtimeOrigin + source,
    }),
    undefined,
  );
});

const invalidSparkSources = [
  "/chat?environment=dev&spark=1",
  "/notifications?environment=dev&spark=1",
  "/home?spark=1",
  "/home?environment=dev&message=1&messageCreatedAt=1000",
  "/home?environment=&spark=1",
  "/home?environment=%20dev&spark=1",
  "/home?environment=dev%00&spark=1",
  "/home?environment=dev&environment=other&spark=1",
  "/home?environment=dev&spark=0",
  "/home?environment=dev&spark=",
  sparkSource + "&spark=1",
  sparkSource + "&session=ordinary",
  sparkSource + "&redirect=https%3A%2F%2Fexample.com",
  sparkSource + "&extra=1",
  sparkSource + "&message=1",
  sparkSource + "&messageCreatedAt=1000",
  sparkSource + "&request=direct-request",
  sparkSource + "&message=&messageCreatedAt=1000",
  sparkSource + "&message=%20id&messageCreatedAt=1000",
  sparkSource + "&message=id%7F&messageCreatedAt=1000",
  sparkSource + "&message=" + "x".repeat(513) + "&messageCreatedAt=1000",
  messageSource + "&message=2",
  messageSource + "&messageCreatedAt=1001",
  messageSource + "&request=",
  messageSource + "&request=%20request",
  messageSource + "&request=request%00",
  messageSource + "&request=" + "x".repeat(513),
  messageSource + "&request=first&request=second",
  ...[
    "",
    "-1",
    "1.5",
    "NaN",
    "Infinity",
    "9007199254740992",
    "01",
    "1e3",
    "%201000",
  ].map(
    (timestamp) => sparkSource + "&message=1&messageCreatedAt=" + timestamp,
  ),
  "https://example.com" + messageSource,
  "//example.com" + messageSource,
  "http://abot-notify.localhost:5988" + messageSource,
  messageSource + "#external",
];

test.each(invalidSparkSources)(
  "rejects unsafe SPARK destination %s before native rendering",
  async (source) => {
    const native = nativeDelivery();
    const result = await native.submit(source);
    expect(result).toMatchObject({ ok: false });
    expect(native.renderer.send).not.toHaveBeenCalled();
  },
);
