import { describe, expect, test } from "vitest";
import { buildConversationActivityModel, createConversationActivity } from "../../web-ui/app/components/conversation-activity.js";
import { projectToolActivityEvent } from "../../web-ui/app/lib/tool-activity-event.js";
import { buildConversationToolActions } from "../../web-ui/app/lib/tool-activity-model.js";
import { buildConversationStatus } from "../../web-ui/app/lib/conversation-status-model.js";
import { formatEventDetail } from "../../web-ui/app/lib/event-presentation.js";
import { enrichEventPayload } from "../events/event-status.js";
import { ContextElement } from "./support/composer-context-window-dom.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

const BODY = "SOURCE_BODY_MUST_NEVER_APPEAR";
const NAME = 'מסמך <img src=x onerror="bad()">';
type Event = Record<string, unknown>;

function toolEvent(action: string, sequence: number, extra: Event = {}): Event {
  return {
    type: "event", name: "tool.completed", requestId: "request-1", sessionId: "session-1",
    eventSequence: sequence, executionId: "basket-" + sequence, executorRole: "worker",
    tool: "information_basket", ok: true,
    meta: { basketAction: action, itemCount: 1, documentName: NAME }, ...extra,
  };
}
function poison() {
  return {
    outputPreview: BODY, inputPreview: BODY, source: BODY, path: BODY, query: BODY,
    displayTarget: BODY, body: BODY, params: { body: BODY }, outputPreviewTruncated: true,
  };
}
function action(event: Event) {
  return buildConversationToolActions({ requestId: "request-1", events: [event] })[0]!;
}
function fields(value: { received: Array<{ label: string; value: string }> }) {
  return Object.fromEntries(value.received.map(field => [field.label, field.value]));
}
function render(events: Event[], streaming = false) {
  const documentRoot = {
    createElement: (tag: string) => Object.assign(new ContextElement(tag), { open: false, title: "" }),
    defaultView: { requestAnimationFrame: () => 0 },
  } as unknown as Document;
  return createConversationActivity({ documentRoot }).createNode({ requestId: "request-1", events, streaming })!;
}

function savedSession(events: Event[]) {
  return {
    sessionId: "session-1",
    messages: [{ id: "answer", role: "assistant", content: "Saved answer", requestId: "request-1" }],
    requests: [{ requestId: "request-1", status: "completed", events,
      finalState: { status: "completed", output: "Saved answer" } }],
  };
}
async function projected(events: Event[], replay: boolean) {
  const wire = events.map(event => enrichEventPayload(event));
  const before = JSON.stringify(wire);
  const harness = createPlanLifecycleHarness(replay ? savedSession(wire) : {});
  if (replay) await harness.conversationSession.openSession("session-1");
  else for (const event of wire) harness.realtime.handle(event);
  expect(JSON.stringify(wire)).toBe(before);
  return harness.state.events as Event[];
}

describe("Information Basket activity display", () => {
  test.each([
    ["list_information_sources", "List information sources"],
    ["search_information_sources", "Search information sources"],
    ["read_information_source", "Read information source"],
  ])("uses an explicit title for %s and never projects generic content fallbacks", (basketAction, title) => {
    const event = toolEvent(basketAction!, 1, {
      output: BODY, intent: BODY, error: BODY, reason: BODY,
      meta: { ...poison(), basketAction, basketSourceId: "HIDDEN_SOURCE_ID", itemCount: 1,
        documentName: NAME, documentName1: NAME, basketSearchStatus: "found", omittedDocumentCount: 0 },
    });
    const projected = projectToolActivityEvent(event)!;
    expect(projected.activityTitle).toBe(title);
    expect(projected.preview).toBe("");
    expect(projected.previewTruncated).toBe(false);
    expect(projected.intent).toBe("");
    expect(JSON.stringify(projected)).not.toContain(BODY);
    expect(JSON.stringify(projected)).not.toContain("HIDDEN_SOURCE_ID");
    expect(formatEventDetail(event)).not.toContain(BODY);
    const node = render([event]);
    expect(node.textContent).toContain(title!);
    expect(node.textContent).toContain(NAME);
    expect(node.textContent).not.toContain(BODY);
    expect(node.querySelector("img")).toBeNull();
    expect(node.querySelector("script")).toBeNull();
    expect(node.querySelector(".conversation-tool-preview")).toBeNull();
  });

  test("shows at most five sanitized bounded names with distinct returned and omitted counts", () => {
    const long = "x".repeat(300);
    const event = toolEvent("search_information_sources", 1, { meta: {
      basketAction: "search_information_sources", basketSearchStatus: "found", itemCount: 8, omittedDocumentCount: 12,
      documentName1: "  first\u0000\n name  ", documentName2: long, documentName3: "third", documentName4: "fourth",
      documentName5: "fifth", documentName6: "SIXTH_NOT_DECLARED", ...poison(),
    } });
    const projected = projectToolActivityEvent(event)!;
    const received = fields(projected);
    expect(received["Matching sources"]).toBe("8");
    expect(received["Further sources"]).toBe("12");
    expect(received["Returned sources without displayed names"]).toBe("3");
    expect(received.Documents).toBe(["first name", "x".repeat(119) + "…", "third", "fourth", "fifth"].join(", "));
    expect(JSON.stringify(projected)).not.toContain("SIXTH_NOT_DECLARED");
    expect(JSON.stringify(projected)).not.toContain(BODY);
    expect(projected.target).toBe("8 sources");
  });

  test("name bounds preserve Unicode characters and remove hidden formatting controls", () => {
    const event = toolEvent("read_information_source", 1, { meta: {
      basketAction: "read_information_source", itemCount: 1, documentName: "\u200b\u2060" + "😀".repeat(121),
    } });
    const projected = projectToolActivityEvent(event)!;
    expect(projected.target).toBe("😀".repeat(119) + "…");
    expect(Array.from(projected.target)).toHaveLength(120);
    expect(projected.target).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });

  test("unknown or invalid metadata stays generic and does not invent counts or source targets", () => {
    const unknown = projectToolActivityEvent(toolEvent("UNKNOWN_" + BODY, 1, {
      meta: { basketAction: "UNKNOWN_" + BODY, documentName: BODY, documentName1: BODY, itemCount: 7, ...poison() },
    }))!;
    expect(unknown.activityTitle).toBe("Information Basket");
    expect(unknown.target).toBe("");
    expect(unknown.sent).toEqual([]);
    expect(unknown.received).toEqual([]);
    expect(JSON.stringify(unknown)).not.toContain(BODY);
    const invalid = projectToolActivityEvent(toolEvent("list_information_sources", 1, {
      meta: { basketAction: "list_information_sources", itemCount: -1, omittedDocumentCount: 1.5 },
    }))!;
    expect(invalid.target).toBe("");
    expect(invalid.received).toEqual([]);
  });

  test("a read shows a known document name and never substitutes its ID or path", () => {
    const pending = toolEvent("read_information_source", 1, { name: "tool.started", ok: undefined,
      meta: { basketAction: "read_information_source", basketSourceId: "SECRET_ID", path: "SECRET_PATH" } });
    expect(projectToolActivityEvent(pending)!.target).toBe("");
    const known = toolEvent("read_information_source", 1);
    expect(action(known).target).toBe(NAME);
    expect(fields(action(known))).toMatchObject({ "Sources read": "1", Document: NAME });
    const failed = toolEvent("read_information_source", 1, { ok: false, meta: {
      basketAction: "read_information_source", documentName: NAME, errorCode: "basket_source_stale", ...poison(),
    } });
    expect(action(failed).status).toBe("failed");
    expect(action(failed).received).toContainEqual({ label: "Error", value: "basket_source_stale" });
    expect(JSON.stringify(action(failed))).not.toContain(BODY);
  });

  test("empty and unavailable searches are presented without claiming source evidence", () => {
    const empty = action(toolEvent("search_information_sources", 1, { meta: {
      basketAction: "search_information_sources", basketSearchStatus: "empty", itemCount: 0,
      documentName1: "MUST_NOT_SHOW_FOR_ZERO", omittedDocumentCount: 0,
    } }));
    expect(empty.statusLabel).toBe("No results");
    expect(fields(empty)).toMatchObject({ "Matching sources": "0", "Search status": "No matches" });
    expect(JSON.stringify(empty)).not.toContain("MUST_NOT_SHOW_FOR_ZERO");
    const unavailable = action(toolEvent("search_information_sources", 2, { meta: {
      basketAction: "search_information_sources", basketSearchStatus: "unavailable", itemCount: 0,
    } }));
    expect(fields(unavailable)["Search status"]).toBe("Unavailable");
    expect(unavailable.status).toBe("completed");
    expect(unavailable.statusLabel).not.toBe("No results");
  });

  test.each([false, true])("preserves names/counts and suppresses source bodies in live/replay UI (replay=%s)", async replay => {
    const events = [
      toolEvent("search_information_sources", 1, { name: "tool.started", ok: undefined,
        meta: { basketAction: "search_information_sources", ...poison() } }),
      toolEvent("search_information_sources", 2, { executionId: "basket-1", output: BODY, intent: BODY,
        meta: { basketAction: "search_information_sources", basketSearchStatus: "found", itemCount: 2,
          documentName1: NAME, documentName2: "Project plan", omittedDocumentCount: 4, ...poison() } }),
      toolEvent("read_information_source", 3, { name: "tool.started", ok: undefined }),
      toolEvent("read_information_source", 4, { executionId: "basket-3", output: BODY,
        meta: { basketAction: "read_information_source", documentName: NAME, itemCount: 1, ...poison() } }),
    ];
    const retained = await projected(events, replay);
    const model = buildConversationActivityModel({ requestId: "request-1", events: retained });
    expect(model.toolCount).toBe(2);
    expect(model.toolActions.map(entry => entry.title)).toEqual(["Search information sources", "Read information source"]);
    expect(fields(model.toolActions[0]!)).toMatchObject({ "Matching sources": "2", "Further sources": "4" });
    const node = render(retained);
    expect(node.textContent).toContain(NAME);
    expect(node.textContent).toContain("Project plan");
    expect(node.textContent).not.toContain(BODY);
    expect(JSON.stringify(retained)).not.toContain(BODY);
    expect(node.querySelector("img")).toBeNull();
  });

  test.each([false, true])("passive and SUPER status messages stay visible without adding or masking tool work (replay=%s)", async replay => {
    const running = toolEvent("read_information_source", 1, { name: "tool.started", ok: undefined });
    const messages = ["Found 2 relevant information sources: plan_v2.md, notes.txt", "Searching information sources",
      "Read information source: plan_v2.md"];
    const events = [running, ...messages.map((message, index) => ({
      type: "event", name: "runtime.state", requestId: "request-1", sessionId: "session-1",
      eventSequence: index + 2, stage: "information_basket", phase: ["discovery_found", "search_started", "read_completed"][index],
      message,
    }))];
    const retained = await projected(events, replay);
    const model = buildConversationActivityModel({ requestId: "request-1", events: retained, streaming: true });
    expect(model.toolCount).toBe(1);
    expect(model.toolActions).toHaveLength(1);
    expect(model.toolActions[0]!.status).toBe("running");
    expect(buildConversationStatus({ requestId: "request-1", events: retained, streaming: true }))
      .toEqual({ label: "Running tool", animate: true });
    const node = render(retained, true);
    for (const message of messages) expect(node.textContent).toContain(message);
  });


  test.each([false, true])("distinguishes returned read windows in live/replay cards (replay=%s)", async replay => {
    const events = [
      toolEvent("read_information_source", 1, { name: "tool.started", ok: undefined }),
      toolEvent("read_information_source", 2, { executionId: "basket-1", meta: {
        basketAction: "read_information_source", documentName: NAME, itemCount: 1,
        basketReadStartChar: 0, basketReadEndChar: 8_000, basketReadTotalCharacters: 17_740,
      } }),
      toolEvent("read_information_source", 3, { name: "tool.started", ok: undefined }),
      toolEvent("read_information_source", 4, { executionId: "basket-3", meta: {
        basketAction: "read_information_source", documentName: NAME, itemCount: 1,
        basketReadStartChar: 8_000, basketReadEndChar: 17_740, basketReadTotalCharacters: 17_740,
      } }),
    ];
    const retained = await projected(events, replay);
    const model = buildConversationActivityModel({ requestId: "request-1", events: retained });
    expect(model.toolCount).toBe(2);
    expect(model.toolActions.map(entry => entry.title)).toEqual(["Read information source", "Continue reading source"]);
    expect(model.toolActions.map(entry => entry.status)).toEqual(["completed", "completed"]);
    expect(fields(model.toolActions[0]!)).toMatchObject({
      "Characters read": "1–8,000 of 17,740", "Read coverage": "More remaining",
    });
    expect(fields(model.toolActions[1]!)).toMatchObject({
      "Characters read": "8,001–17,740 of 17,740", "Read coverage": "End of source reached",
    });
    const node = render(retained);
    for (const text of ["Continue reading source", "1–8,000 of 17,740", "8,001–17,740 of 17,740",
      "More remaining", "End of source reached"]) expect(node.textContent).toContain(text);
    expect(formatEventDetail(events[3]!)).toContain("8,001–17,740 of 17,740");
  });

  test("an isolated tail read describes its range without claiming earlier text was read", () => {
    const event = toolEvent("read_information_source", 1, { meta: {
      basketAction: "read_information_source", documentName: NAME, itemCount: 1,
      basketReadStartChar: 8_000, basketReadEndChar: 17_740, basketReadTotalCharacters: 17_740,
    } });
    expect(fields(action(event))).toMatchObject({
      "Characters read": "8,001–17,740 of 17,740", "Read coverage": "End of source reached",
    });
  });

  test.each([0, 17_740])("empty read windows do not invent a character range (total=%s)", total => {
    const event = toolEvent("read_information_source", 1, { meta: {
      basketAction: "read_information_source", itemCount: 1,
      basketReadStartChar: total, basketReadEndChar: total, basketReadTotalCharacters: total,
    } });
    expect(fields(action(event))).toMatchObject({
      "Characters read": `0 of ${total.toLocaleString("en-US")}`, "Read coverage": "No characters returned",
    });
  });

  test.each([
    {}, { basketReadStartChar: 8_000 }, { basketReadStartChar: "8000", basketReadEndChar: 17_740, basketReadTotalCharacters: 17_740 },
    { basketReadStartChar: -1, basketReadEndChar: 8_000, basketReadTotalCharacters: 17_740 },
    { basketReadStartChar: 0.5, basketReadEndChar: 8_000, basketReadTotalCharacters: 17_740 },
    { basketReadStartChar: 8_000, basketReadEndChar: 7_999, basketReadTotalCharacters: 17_740 },
    { basketReadStartChar: 0, basketReadEndChar: 17_741, basketReadTotalCharacters: 17_740 },
    { basketReadStartChar: 0, basketReadEndChar: 8_000, basketReadTotalCharacters: Number.MAX_SAFE_INTEGER + 1 },
  ])("legacy or invalid coverage retains the original read presentation: %j", coverage => {
    const event = toolEvent("read_information_source", 1, { meta: {
      basketAction: "read_information_source", documentName: NAME, itemCount: 1, ...coverage,
    } });
    expect(action(event).title).toBe("Read information source");
    expect(fields(action(event))).toEqual({ "Sources read": "1", Document: NAME });
  });

  test.each([
    { name: "tool.started", ok: undefined, basketAction: "read_information_source" },
    { name: "tool.completed", ok: false, basketAction: "read_information_source" },
    { name: "tool.completed", ok: true, basketAction: "search_information_sources" },
  ])("does not claim read coverage for pending, failed or unrelated operations: %j", ({ basketAction, ...extra }) => {
    const event = toolEvent(basketAction, 1, { ...extra, meta: {
      basketAction, basketReadStartChar: 8_000, basketReadEndChar: 17_740, basketReadTotalCharacters: 17_740,
    } });
    expect(action(event).title).not.toBe("Continue reading source");
    expect(fields(action(event))).not.toHaveProperty("Characters read");
    expect(fields(action(event))).not.toHaveProperty("Read coverage");
  });

  test("unrelated tool previews retain their existing behavior", () => {
    const event = toolEvent("read_information_source", 1, { tool: "read_file", meta: {
      path: "notes.txt", outputPreview: "Existing file preview", inputPreview: "Existing input preview",
    } });
    expect(projectToolActivityEvent(event)!.preview).toBe("Existing file preview");
  });
});
