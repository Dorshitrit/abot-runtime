import { describe, expect, test } from "vitest";

import {
  createInitialWorkspaceShellState,
  insertRequestUserMessageBeforeAssistant,
  isMatchingActiveRequest,
  isNearScrollEnd,
  matchesSessionQuery,
  normalizeWorkspaceDestination,
  pinScrollToEnd,
  resolveComposerPrimaryAction,
  toggleWorkspaceSheet,
  wrappedIndex,
} from "../../web-ui/app/ui-behavior.js";
import {
  renderMarkdown,
  safeLinkHref,
} from "../../web-ui/app/lib/text-format.js";
import {
  modelAcceptsComposerAttachment,
  resolveComposerAttachmentMimeType,
} from "../../web-ui/app/lib/attachment-policy.js";
import {
  buildEventTimelineEntries,
  eventTone,
  formatEventLabel,
  getPlanPayload,
  isLowValueActivityEvent,
} from "../../web-ui/app/lib/event-presentation.js";
import { createComposerActions } from "../../web-ui/app/components/composer-actions.js";

function fakeComposerElement() {
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  return {
    hidden: false,
    disabled: false,
    title: "",
    textContent: "",
    dataset: {} as Record<string, string>,
    classList: {
      toggle(name: string, active: boolean) {
        if (active) classes.add(name);
        else classes.delete(name);
      },
      contains(name: string) {
        return classes.has(name);
      },
    },
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
    getAttribute(name: string) {
      return attributes.get(name) ?? null;
    },
    addEventListener() {},
    contains() {
      return false;
    },
    focus() {},
  };
}

describe("web ui client behavior", () => {
  test("filters conversations across titles, previews, and ids", () => {
    const values = ["Daily Research", "סיכום חדשות", "session-42"];

    expect(matchesSessionQuery(values, "research")).toBe(true);
    expect(matchesSessionQuery(values, "חדשות")).toBe(true);
    expect(matchesSessionQuery(values, "42")).toBe(true);
    expect(matchesSessionQuery(values, "missing")).toBe(false);
    expect(matchesSessionQuery(values, "  ")).toBe(true);
  });

  test("follows output only while the viewport remains near the end", () => {
    expect(
      isNearScrollEnd({
        scrollHeight: 1_000,
        scrollTop: 620,
        clientHeight: 300,
      }),
    ).toBe(true);
    expect(
      isNearScrollEnd({
        scrollHeight: 1_000,
        scrollTop: 500,
        clientHeight: 300,
      }),
    ).toBe(false);
  });

  test("pins a newly rendered conversation to its exact end", () => {
    const viewport = {
      scrollHeight: 2_400,
      scrollTop: 700,
      clientHeight: 800,
      style: { scrollBehavior: "smooth" },
    };

    pinScrollToEnd(viewport);

    expect(viewport.scrollTop).toBe(2_400);
    expect(viewport.style.scrollBehavior).toBe("smooth");
  });

  test("wraps keyboard tab navigation in both directions", () => {
    expect(wrappedIndex(5, 1, 6)).toBe(0);
    expect(wrappedIndex(0, -1, 6)).toBe(5);
    expect(wrappedIndex(2, 1, 6)).toBe(3);
    expect(wrappedIndex(0, 1, 0)).toBe(-1);
  });

  test("keeps chat and config as the only workspace destinations", () => {
    expect(normalizeWorkspaceDestination("operations")).toBe("chat");
    expect(normalizeWorkspaceDestination("config")).toBe("config");
    expect(normalizeWorkspaceDestination("CHAT")).toBe("chat");
    expect(normalizeWorkspaceDestination("unknown")).toBe("chat");
  });

  test("boots into chat with both workspace sheets closed", () => {
    expect(createInitialWorkspaceShellState()).toEqual({
      workspace: "chat",
      activeSheet: "",
    });
  });

  test("keeps conversations as the only transient workspace sheet", () => {
    expect(toggleWorkspaceSheet("", "sessions")).toBe("sessions");
    expect(toggleWorkspaceSheet("sessions", "sessions")).toBe("");
    expect(toggleWorkspaceSheet("sessions", "activity")).toBe("");
    expect(toggleWorkspaceSheet("sessions", "unknown")).toBe("");
  });

  test("routes the composer by exact active-request and attachment state", () => {
    expect(resolveComposerPrimaryAction("", 0)).toBe("send");
    expect(resolveComposerPrimaryAction("request-active", 0)).toBe("steer");
    expect(resolveComposerPrimaryAction("request-active", 1)).toBe("send_next");
    expect(isMatchingActiveRequest("request-active", "request-active")).toBe(
      true,
    );
    expect(isMatchingActiveRequest("request-active", "request-other")).toBe(
      false,
    );
  });

  test("places an acknowledged steer before its request assistant response", () => {
    const messages = [
      { id: "user-1", role: "user", requestId: "request-1" },
      { id: "assistant-1", role: "assistant", requestId: "request-1" },
      { id: "user-2", role: "user", requestId: "request-2" },
    ];
    const steered = insertRequestUserMessageBeforeAssistant(messages, {
      id: "steer-1",
      role: "user",
      requestId: "request-1",
    });

    expect(steered.map((message) => message.id)).toEqual([
      "user-1",
      "steer-1",
      "assistant-1",
      "user-2",
    ]);
    expect(messages.map((message) => message.id)).toEqual([
      "user-1",
      "assistant-1",
      "user-2",
    ]);
  });

  test("presents steer as the active primary action and forces attachments to send next", () => {
    const dom = {
      composerForm: fakeComposerElement(),
      composerSubmitControl: fakeComposerElement(),
      sendButton: fakeComposerElement(),
      sendButtonLabel: fakeComposerElement(),
      sendNextMenuButton: fakeComposerElement(),
      sendNextMenu: fakeComposerElement(),
      sendNextButton: fakeComposerElement(),
    };
    const actions = createComposerActions({
      dom: dom as never,
      onSendNext() {},
      documentRoot: { addEventListener() {} } as never,
    });

    actions.render({ activeRequestId: "request-active", queuedCount: 2 });
    expect(actions.primaryAction()).toBe("steer");
    expect(dom.sendButton.dataset.action).toBe("steer");
    expect(dom.sendNextMenuButton.hidden).toBe(false);
    expect(dom.sendNextMenuButton.dataset.count).toBe("2");
    expect(dom.sendNextMenuButton.getAttribute("aria-label")).toBe(
      "More send options, 2 queued",
    );
    expect(dom.sendNextButton.textContent).toBe("Send next (2 queued)");

    actions.render({
      activeRequestId: "request-active",
      disabled: true,
    });
    expect(dom.sendNextMenuButton.disabled).toBe(true);
    expect(dom.sendNextButton.disabled).toBe(true);

    actions.render({ activeRequestId: "request-active", busy: true });
    expect(dom.sendButton.disabled).toBe(true);
    expect(dom.sendNextMenuButton.disabled).toBe(true);
    expect(dom.sendNextButton.disabled).toBe(true);

    actions.render({
      activeRequestId: "request-active",
      attachmentCount: 1,
    });
    expect(actions.primaryAction()).toBe("send_next");
    expect(dom.sendButton.dataset.action).toBe("send_next");
    expect(dom.sendNextMenuButton.hidden).toBe(true);

    actions.render({ activeRequestId: "" });
    expect(actions.primaryAction()).toBe("send");
    expect(dom.sendButton.dataset.action).toBe("send");
  });

  test("renders bounded markdown without allowing script links or raw markup", () => {
    expect(renderMarkdown("<img src=x onerror=alert(1)>")).toContain(
      "&lt;img src=x onerror=alert(1)&gt;",
    );
    expect(renderMarkdown("[unsafe](javascript:alert(1))")).not.toContain(
      "href=",
    );
    expect(renderMarkdown("[safe](https://example.com/path)")).toContain(
      'href="https://example.com/path"',
    );
    expect(safeLinkHref("mailto:test@example.com")).toBe(
      "mailto:test@example.com",
    );
  });

  test("allows documents for text models and gates only image attachments", () => {
    expect(
      resolveComposerAttachmentMimeType({ name: "brief.PDF", type: "" }),
    ).toBe("application/pdf");
    expect(
      modelAcceptsComposerAttachment(
        { name: "brief.pdf", type: "application/pdf" },
        false,
      ),
    ).toBe(true);
    expect(
      modelAcceptsComposerAttachment(
        { name: "photo.png", type: "image/png" },
        false,
      ),
    ).toBe(false);
    expect(
      modelAcceptsComposerAttachment(
        { name: "photo.png", type: "image/png" },
        true,
      ),
    ).toBe(true);
  });

  test("keeps activity presentation separate from realtime state handling", () => {
    expect(
      formatEventLabel({ name: "tool.completed", tool: "web_search" }),
    ).toBe("web search completed");
    expect(eventTone({ type: "failed", name: "request.failed" })).toBe(
      "failed",
    );
    expect(eventTone({ name: "tool.completed", ok: false })).toBe("failed");
    expect(
      getPlanPayload({
        plan: {
          summary: "Ship the UI",
          items: [{ id: "one", title: "Review", status: "done" }],
        },
      }),
    ).toMatchObject({ summary: "Ship the UI", total: 1, completed: 1 });
    expect(
      buildEventTimelineEntries([
        { name: "Tool", summary: "done", tone: "done" },
        { name: "Tool", summary: "done", tone: "done" },
      ]),
    ).toEqual([{ name: "Tool", summary: "done", tone: "done", count: 2 }]);
  });

  test("never suppresses failures as low-value activity", () => {
    expect(
      isLowValueActivityEvent({ type: "failed", name: "request.failed" }),
    ).toBe(false);
    expect(isLowValueActivityEvent({ name: "request_progress" })).toBe(true);
    expect(
      isLowValueActivityEvent({
        type: "completed",
        name: "request.completed",
      }),
    ).toBe(true);
  });
});
