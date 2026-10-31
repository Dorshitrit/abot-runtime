import { expect, test } from "vitest";
import { conversationTitle } from "../../web-ui/app/lib/conversation-title.js";
// @ts-expect-error Browser-only controller.
import { createSessionController } from "../../web-ui/app/controllers/session-controller.js";

test("unnamed and failed first conversations do not expose their storage identity", () => {
  const session = { id: "abot-web-generated", title: "abot-web-generated" };
  const dom = { sessionTitle: { textContent: "" } };
  const state = { currentSessionId: session.id, sessions: [session] };
  const controller = createSessionController({ state, dom, preferences: {} });
  expect(controller.titleOf(session)).toBe("Untitled conversation");
  controller.setCurrentTitle(session.id);
  expect(dom.sessionTitle.textContent).toBe("Untitled conversation");
  controller.setCurrentTitle("New conversation");
  expect(dom.sessionTitle.textContent).toBe("New conversation");
  expect(session.title).toBe(session.id);
});

test("explicit conversation names take precedence, including a user-selected identifier", () => {
  expect(conversationTitle({ id: "id", title: "Generated title", displayName: "Renamed chat" }))
    .toBe("Renamed chat");
  expect(conversationTitle({ id: "id", title: "Generated title" })).toBe("Generated title");
  expect(conversationTitle({ id: "id", title: "id", displayName: "id" })).toBe("id");
  expect(conversationTitle({ id: "id", title: "  " })).toBe("Untitled conversation");
});
