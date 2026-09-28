import { describe, expect, test, vi, afterEach } from "vitest";
// @ts-expect-error Browser module has no declaration surface.
import { createNotificationPresence } from "../../web-ui/app/controllers/notification-presence.js";

function fixture() {
  const page = new EventTarget();
  const documentRoot = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    hasFocus: () => focused,
  });
  let focused = true;
  let sessionId = "session-a";
  let workspace = "chat";
  let connected = true;
  let environment = "prod";
  const send = vi.fn();
  const presence = createNotificationPresence({
    getEnvironmentId: () => environment,
    getSessionId: () => sessionId,
    getWorkspace: () => workspace,
    isConnected: () => connected,
    send,
    documentRoot,
    viewport: page,
  });
  return {
    presence, page, documentRoot, send,
    setFocus: (value: boolean) => { focused = value; },
    setSession: (value: string) => { sessionId = value; },
    setWorkspace: (value: string) => { workspace = value; },
    setEnvironment: (value: string) => { environment = value; },
    setConnected: (value: boolean) => { connected = value; },
  };
}

afterEach(() => vi.useRealTimers());

describe("notification viewing presence", () => {
  test("requires a visible, focused chat with a selected session", () => {
    vi.useFakeTimers();
    const f = fixture();
    f.presence.bind();
    expect(f.send).toHaveBeenLastCalledWith({
      type: "notification_presence", environment: "prod", sessionId: "session-a", active: true,
    });
    f.setFocus(false);
    f.page.dispatchEvent(new Event("blur"));
    expect(f.send.mock.lastCall?.[0].active).toBe(false);
    f.setFocus(true);
    f.documentRoot.visibilityState = "hidden";
    f.documentRoot.dispatchEvent(new Event("visibilitychange"));
    expect(f.send.mock.lastCall?.[0].active).toBe(false);
    f.documentRoot.visibilityState = "visible";
    f.setWorkspace("notifications");
    f.presence.changed();
    expect(f.send.mock.lastCall?.[0].active).toBe(false);
    f.setWorkspace("chat");
    f.setSession("");
    f.presence.changed();
    expect(f.send.mock.lastCall?.[0].active).toBe(false);
    f.presence.dispose();
  });

  test("heartbeats are not postponed by repeated unchanged message renders", () => {
    vi.useFakeTimers();
    const f = fixture();
    f.presence.bind();
    for (let index = 0; index < 4; index += 1) {
      vi.advanceTimersByTime(5_000);
      f.presence.changed();
    }
    expect(f.send).toHaveBeenCalledTimes(2);
    f.setSession("session-b");
    f.presence.changed();
    expect(f.send.mock.lastCall?.[0].sessionId).toBe("session-b");
    f.setEnvironment("dev");
    f.presence.changed();
    expect(f.send.mock.lastCall?.[0].environment).toBe("dev");
    f.page.dispatchEvent(new Event("pagehide"));
    expect(f.send.mock.lastCall?.[0].active).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(f.send).toHaveBeenCalledTimes(5);
    f.presence.dispose();
  });

  test("reconnect republishes current presence and offline state sends nothing", () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setConnected(false);
    f.presence.bind();
    expect(f.send).not.toHaveBeenCalled();
    f.setConnected(true);
    f.presence.reconnect();
    expect(f.send).toHaveBeenCalledOnce();
    f.presence.reconnect();
    expect(f.send).toHaveBeenCalledTimes(2);
    f.presence.dispose();
  });
});
