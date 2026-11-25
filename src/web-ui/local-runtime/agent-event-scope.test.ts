import { expect, test, vi, afterEach } from "vitest";
import { readAgentAssociations } from "../../runtime/agents/session-association.js";
import { createOrdinaryChatEventPublisher } from "./agent-event-scope.js";
vi.mock("../../runtime/agents/session-association.js", () => ({ readAgentAssociations: vi.fn() }));
afterEach(() => vi.resetAllMocks());
function fixture() {
  vi.mocked(readAgentAssociations).mockResolvedValue({ sessionIds: new Set(["agent-session"]), requestIds: new Set(["agent-request"]) });
  const publish = vi.fn(); const unavailable = vi.fn();
  const scoped = createOrdinaryChatEventPublisher({ runtimeDir: (id) => `/fictional/${id}`, publish, unavailable });
  return { scoped, publish, unavailable };
}
test("ordinary events retain exact payload and ordering; Agent events never enter Chat", async () => {
  const f = fixture(); const first = { type: "message", requestId: "chat-1", sessionId: "chat", seq: 1 }; const last = { ...first, seq: 2, type: "completed" };
  f.scoped.publish(first, "dev"); f.scoped.publish({ type: "completed", requestId: "agent-request" }, "dev");
  f.scoped.publish({ type: "approval_required", sessionId: "agent-session" }, "dev"); f.scoped.publish(last, "dev");
  await f.scoped.flush(); expect(f.publish.mock.calls.map(([event]) => event)).toEqual([first, last]);
});
test("classification is scoped to its environment and immutable request identity", async () => {
  const f = fixture(); const event = { type: "delta", requestId: "chat", sessionId: "chat" };
  f.scoped.publish(event, "dev"); f.scoped.publish(event, "dev"); f.scoped.publish(event, "prod");
  await f.scoped.flush(); expect(readAgentAssociations).toHaveBeenCalledTimes(2); expect(f.publish).toHaveBeenCalledTimes(3);
  expect(readAgentAssociations).toHaveBeenCalledWith("/fictional/dev"); expect(readAgentAssociations).toHaveBeenCalledWith("/fictional/prod");
});
test("unreadable index withholds scoped events and can recover without leaking them", async () => {
  const f = fixture(); vi.mocked(readAgentAssociations).mockRejectedValueOnce(new Error("bad index"));
  const event = { type: "completed", requestId: "request", sessionId: "session" };
  f.scoped.publish(event, "dev"); await f.scoped.flush(); expect(f.publish).not.toHaveBeenCalled(); expect(f.unavailable).toHaveBeenCalledWith("dev");
  f.scoped.publish(event, "dev"); await f.scoped.flush(); expect(f.publish).toHaveBeenCalledExactlyOnceWith(event);
});
test("unscoped workspace events pass unchanged without reading an association index", async () => {
  const f = fixture(); const event = { type: "workspace_changed", resources: ["models"] };
  f.scoped.publish(event, "dev"); await f.scoped.flush(); expect(f.publish).toHaveBeenCalledExactlyOnceWith(event); expect(readAgentAssociations).not.toHaveBeenCalled();
});

test("closing the event publisher drains accepted events and closes admission", async () => {
  const f = fixture();
  const last = { type: "completed", requestId: "before-stop" };
  f.scoped.publish(last, "dev");
  const stopped = f.scoped.stop();
  f.scoped.publish({ type: "completed", requestId: "after-stop" }, "dev");
  await stopped;
  expect(f.publish).toHaveBeenCalledExactlyOnceWith(last);
  expect(readAgentAssociations).toHaveBeenCalledTimes(1);
});
