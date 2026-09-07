import { describe, expect, test } from "vitest";

import { createConversationActivity } from "../../web-ui/app/components/conversation-activity.js";
import { createConversationRoleCards } from "../../web-ui/app/components/conversation-role-cards.js";
import type { ConversationRoleCard } from "../../web-ui/app/lib/conversation-role-model.js";
import { ContextElement } from "./support/composer-context-window-dom.js";

type ActivityElement = ContextElement & {
  open: boolean;
  scrollTop: number;
  scrollHeight: number;
};

function createRoleDom() {
  const frames: Array<() => void> = [];
  const createElement = (tag: string) =>
    Object.assign(new ContextElement(tag), {
      open: false,
      scrollTop: 0,
      scrollHeight: 500,
    });
  const documentRoot = {
    createElement,
    defaultView: {
      requestAnimationFrame(callback: () => void) {
        frames.push(callback);
        return frames.length;
      },
    },
  } as unknown as Document;
  return {
    documentRoot,
    flushFrames: () => frames.splice(0).forEach((callback) => callback()),
  };
}

function child(root: HTMLElement, selector: string) {
  const element = root.querySelector(selector);
  expect(element).not.toBeNull();
  return element as unknown as ActivityElement;
}

const worker: ConversationRoleCard = {
  id: "worker",
  role: "worker",
  title: "Worker",
  responsibility: "Performs assigned tasks",
  phaseLabel: "Working",
  summary: "קורא את הקובץ",
  facts: ["1 tool call"],
  active: true,
  tone: "active",
};

describe("conversation role cards presentation", () => {
  test("distinguishes live, recorded and observed error activity without completion claims", () => {
    const { documentRoot } = createRoleDom();
    const cards = createConversationRoleCards({ documentRoot });
    const render = (card: ConversationRoleCard) =>
      cards.createNode({
        requestId: "request",
        cards: [card],
        timeline: documentRoot.createElement("div"),
        hasTimeline: true,
      });

    const live = render(worker);
    expect(
      child(live, ".conversation-role-active").getAttribute("aria-label"),
    ).toBe("Active role");
    expect(child(live, ".conversation-role-responsibility").textContent).toBe(
      "Performs assigned tasks",
    );
    expect(child(live, ".conversation-role-action-label").textContent).toBe(
      "Latest: ",
    );
    expect(child(live, ".conversation-role-action").getAttribute("dir")).toBe(
      "auto",
    );
    expect(child(live, ".conversation-role-action").tagName).toBe("bdi");
    expect(child(live, ".conversation-role-action").textContent).toBe(
      worker.summary,
    );
    const updatedSummary = "נבדקו שלושה קבצים נוספים";
    const updated = render({ ...worker, summary: updatedSummary });
    const updatedAction = child(updated, ".conversation-role-action");
    expect(updatedAction.getAttribute("dir")).toBe("auto");
    expect(updatedAction.textContent).toBe(updatedSummary);
    expect(updatedAction.textContent).not.toContain("Latest:");
    expect(child(updated, ".conversation-role-action-label").textContent).toBe(
      "Latest: ",
    );
    expect(
      child(live, ".conversation-role-avatar").getAttribute("aria-hidden"),
    ).toBe("true");
    expect(child(live, ".conversation-role-avatar").textContent).toBe("W");

    const history = render({ ...worker, active: false, tone: "recorded" });
    expect(history.querySelector(".conversation-role-active")).toBeNull();
    expect(child(history, ".conversation-role-action-label").textContent).toBe(
      "Latest: ",
    );
    expect(child(history, ".conversation-role-action").textContent).toBe(
      worker.summary,
    );
    expect(history.querySelector(".conversation-role-phase")).toBeNull();
    expect(history.textContent).not.toContain("Completed");

    const error = render({ ...worker, active: false, tone: "failed" });
    expect(child(error, ".conversation-role-error").textContent).toBe(
      "Activity error",
    );
    expect(error.querySelector(".conversation-role-active")).toBeNull();
  });

  test("keeps event text inert and the view toggle keyboard accessible", () => {
    const { documentRoot } = createRoleDom();
    const cards = createConversationRoleCards({ documentRoot });
    const node = cards.createNode({
      requestId: "request",
      cards: [{ ...worker, summary: "<img src=x onerror=alert(1)>" }],
      timeline: documentRoot.createElement("div"),
      hasTimeline: true,
    });
    expect(node.querySelector("img")).toBeNull();
    expect(node.textContent).toContain("<img src=x onerror=alert(1)>");
    const toggle = child(node, ".conversation-role-toggle");
    expect(toggle.tagName).toBe("button");
    expect(toggle.type).toBe("button");
    expect(toggle.getAttribute("aria-controls")).toBe(
      child(node, ".conversation-role-panel").id,
    );
    expect(toggle.textContent).toBe("Show timeline");
    toggle.dispatch("click");
    expect(child(node, ".conversation-role-list").hidden).toBe(true);
    expect(toggle.textContent).toBe("Show agents");
  });
});

describe("role cards in conversation activity", () => {
  const input = {
    requestId: "request",
    streaming: true,
    events: [
      {
        requestId: "request",
        name: "agent.status",
        stage: "worker",
        phase: "working",
        message: "Reading the file",
      },
    ],
  };

  test("retains view choice across updates and terminal history, then forgets or resets it", () => {
    const { documentRoot } = createRoleDom();
    const activity = createConversationActivity({ documentRoot });
    const initial = activity.createNode(input)!;
    expect(child(initial, ".conversation-role-view").dataset.view).toBe(
      "cards",
    );
    child(initial, ".conversation-role-toggle").dispatch("click");

    const update = activity.createNode(input)!;
    expect(child(update, ".conversation-role-view").dataset.view).toBe(
      "timeline",
    );
    const completed = activity.createNode({ ...input, streaming: false })!;
    expect(child(completed, ".conversation-role-view").dataset.view).toBe(
      "timeline",
    );
    expect(completed.querySelector(".conversation-role-active")).toBeNull();

    activity.forget("request");
    const forgotten = activity.createNode(input)!;
    expect(child(forgotten, ".conversation-role-view").dataset.view).toBe(
      "cards",
    );
    child(forgotten, ".conversation-role-toggle").dispatch("click");
    activity.reset();
    expect(
      child(activity.createNode(input)!, ".conversation-role-view").dataset
        .view,
    ).toBe("cards");
  });

  test("pins only the streaming timeline and returns to the top for cards", () => {
    const { documentRoot, flushFrames } = createRoleDom();
    const node = createConversationActivity({ documentRoot }).createNode(
      input,
    )!;
    const body = child(node, ".conversation-activity-body");
    const toggle = child(node, ".conversation-role-toggle");
    flushFrames();
    expect(body.scrollTop).toBe(0);
    toggle.dispatch("click");
    flushFrames();
    expect(body.scrollTop).toBe(500);
    toggle.dispatch("click");
    flushFrames();
    expect(body.scrollTop).toBe(0);
  });

  test("restores cards scroll in recreated bodies until the view, request or session resets", () => {
    const { documentRoot, flushFrames } = createRoleDom();
    const activity = createConversationActivity({ documentRoot });
    const initial = activity.createNode(input)!;
    flushFrames();
    const initialBody = child(initial, ".conversation-activity-body");
    initialBody.scrollTop = 140;
    initialBody.dispatch("scroll");

    const updated = activity.createNode(input)!;
    const updatedBody = child(updated, ".conversation-activity-body");
    expect(updatedBody).not.toBe(initialBody);
    flushFrames();
    expect(updatedBody.scrollTop).toBe(140);
    initialBody.scrollTop = 0;
    initialBody.dispatch("scroll");

    const completed = activity.createNode({ ...input, streaming: false })!;
    (completed as unknown as ActivityElement).open = true;
    flushFrames();
    expect(child(completed, ".conversation-activity-body").scrollTop).toBe(140);
    const toggle = child(completed, ".conversation-role-toggle");
    toggle.dispatch("click");
    toggle.dispatch("click");
    flushFrames();
    expect(child(completed, ".conversation-activity-body").scrollTop).toBe(0);

    for (const reset of [
      () => activity.forget("request"),
      () => activity.reset(),
    ]) {
      const node = activity.createNode(input)!;
      flushFrames();
      const body = child(node, ".conversation-activity-body");
      body.scrollTop = 90;
      body.dispatch("scroll");
      reset();
      const recreated = activity.createNode(input)!;
      flushFrames();
      expect(child(recreated, ".conversation-activity-body").scrollTop).toBe(0);
    }
  });

  test.each(["worker", "execution"])(
    "removes duplicate plan panels for %s but preserves counts and plan timeline events",
    (stage) => {
      const { documentRoot, flushFrames } = createRoleDom();
      const taskProgress = {
        requestId: "request",
        summary: "Long plan",
        total: 1,
        completed: 0,
        activeItem: "Read file",
        items: [{ id: "task", title: "Read file", status: "pending" }],
      };
      const activity = createConversationActivity({ documentRoot });
      const node = activity.createNode({
        ...input,
        taskProgress,
        events: [
          { ...input.events[0], stage },
          {
            requestId: "request",
            eventName: "agent.status",
            name: "Plan updated",
            stage: "development_plan",
            summary: "Read file, then summarize",
          },
        ],
      })!;
      expect(node.querySelector(".conversation-activity-progress")).toBeNull();
      expect(child(node, ".conversation-activity-facts").textContent).toContain(
        "0/1 steps",
      );
      expect(child(node, ".conversation-activity-current").textContent).toBe(
        "Read file",
      );
      const toggle = node.querySelector(
        ".conversation-role-toggle",
      ) as unknown as ActivityElement | null;
      toggle?.dispatch("click");
      flushFrames();
      expect(node.querySelector(".conversation-activity-progress")).toBeNull();
      const timeline = child(node, ".conversation-activity-timeline");
      expect(timeline.hidden).toBe(false);
      expect(timeline.textContent).toContain("Plan updated");
      expect(timeline.textContent).toContain("Read file, then summarize");
      expect(child(node, ".conversation-activity-body").scrollTop).toBe(500);
    },
  );

  test("keeps unknown activity available in the existing timeline without empty role cards", () => {
    const { documentRoot } = createRoleDom();
    const node = createConversationActivity({ documentRoot }).createNode({
      ...input,
      events: [{ ...input.events[0], stage: "execution", phase: "executing" }],
    })!;
    expect(node.querySelector(".conversation-role-toggle")).toBeNull();
    expect(child(node, ".conversation-activity-timeline").hidden).toBe(false);
  });
});
