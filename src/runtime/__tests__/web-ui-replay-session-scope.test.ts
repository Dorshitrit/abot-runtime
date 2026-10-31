import { expect, test, vi } from "vitest";
import { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

test("the browser replay client adds a safely encoded hint while legacy callers retain their URL", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ events: [] }));
  const client = createRuntimeWebClient({
    getConfig: () => ({ apiBasePath: "/web-api" }), getEnvironmentId: () => "dev",
    origin: "http://localhost:5177", fetchImpl,
  });
  await client.fetchRequestEvents({ requestId: "request", afterSeq: 7, sessionId: "session /&?" });
  await client.fetchRequestEvents({ requestId: "request", afterSeq: 7 });
  expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
    "/web-api/requests/request/events?afterSeq=7&environment=dev&sessionId=session%20%2F%26%3F",
    "/web-api/requests/request/events?afterSeq=7&environment=dev",
  ]);
});

test("reopening the same active session carries its scope through HTTP and realtime replay", async () => {
  const f = createPlanLifecycleHarness({ messages: [], requests: [{ requestId: "request-1", status: "streaming", events: [] }] });
  await f.conversationSession.openSession("session-1");
  await f.conversationSession.openSession("session-1");
  expect(f.client.fetchRequestEvents).toHaveBeenCalledTimes(2);
  for (const args of f.client.fetchRequestEvents.mock.calls) expect(args).toEqual([{
    requestId: "request-1", sessionId: "session-1", afterSeq: 0, environmentId: "dev",
  }]);
  expect(f.sendRealtime).toHaveBeenCalledWith({
    type: "resume_request", requestId: "request-1", sessionId: "session-1", afterSeq: 0, environment: "dev",
  });
  expect(f.state.activeRequestId).toBe("request-1");
});
