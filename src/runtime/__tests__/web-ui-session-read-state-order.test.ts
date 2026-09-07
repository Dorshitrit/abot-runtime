import { describe, expect, test, vi } from "vitest";

import {
  isOlderSessionReadState,
  mergeSessionListReadState,
} from "../../web-ui/app/lib/session-read-state.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createSessionController } from "../../web-ui/app/controllers/session-controller.js";

describe("web ui session read response ordering", () => {
  test("rejects a stale acknowledgement without rendering unread messages again", () => {
    const known = {
      id: "session-1", lastReadAt: 200, lastReadMessageId: "8",
      unreadCount: 0, hasUnread: false,
    };
    const state = { sessions: [known] };
    const controller = createSessionController({
      state,
      dom: {},
      confirmAction: vi.fn(),
      copyText: vi.fn(),
    });

    expect(controller.applyReadState("session-1", {
      lastReadAt: 100, lastReadMessageId: "4", unreadCount: 2, hasUnread: true,
    })).toBe(false);
    expect(state.sessions[0]).toBe(known);
  });

  test("preserves the newer read receipt while retaining incoming session metadata", () => {
    const incoming = [{
      id: "session-1", title: "Updated title", latestMessageId: 10,
      lastReadAt: 100, lastReadMessageId: "4", unreadCount: 3, hasUnread: true,
    }];
    const known = [{
      id: "session-1",
      readState: {
        lastReadAt: 200, lastReadMessageId: "8", unreadCount: 0, hasUnread: false,
      },
    }];

    const merged = mergeSessionListReadState(incoming, known);

    expect(merged[0]).toMatchObject({
      id: "session-1", title: "Updated title", latestMessageId: 10,
      lastReadAt: 200, lastReadMessageId: "8", unreadCount: 0, hasUnread: false,
      readState: { lastReadAt: 200, lastReadMessageId: "8", unreadCount: 0 },
    });
    expect(incoming[0].unreadCount).toBe(3);
  });

  test("allows equal-cursor list updates to reveal newly arrived unread messages", () => {
    const incoming = [{
      id: "session-1", lastReadAt: 200, unreadCount: 1, hasUnread: true,
    }];
    const merged = mergeSessionListReadState(incoming, [{
      id: "session-1", lastReadAt: 200, unreadCount: 0, hasUnread: false,
    }]);

    expect(merged[0]).toBe(incoming[0]);
    expect(merged[0].unreadCount).toBe(1);
  });

  test.each([undefined, null, "2026-09-06", Number.NaN])(
    "preserves legacy behavior when a numeric read timestamp is absent: %s",
    (timestamp) => {
      expect(isOlderSessionReadState({ lastReadAt: timestamp }, { lastReadAt: 200 }))
        .toBe(false);
      expect(isOlderSessionReadState({ lastReadAt: 100 }, { lastReadAt: timestamp }))
        .toBe(false);
    },
  );
});
