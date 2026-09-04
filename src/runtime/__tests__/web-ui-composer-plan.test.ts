import { describe, expect, test, vi } from "vitest";

import { createComposerPlan } from "../../web-ui/app/components/composer-plan.js";
import {
  buildComposerPlanModel,
  type ComposerPlanMessage,
} from "../../web-ui/app/lib/composer-plan-model.js";
import {
  type ContextElement,
  createComposerContextDom,
} from "./support/composer-context-window-dom.js";

function progress(requestId: string, overrides: Record<string, unknown> = {}) {
  return {
    requestId,
    summary: "Prepare the report",
    total: 5,
    completed: 2,
    hasSignal: true,
    items: [
      { id: "write", title: "Write report", status: "pending", order: 2 },
      { id: "read", title: "Read sources", status: "in_progress", order: 1 },
    ],
    ...overrides,
  };
}

const user = { id: "user-current", role: "user", requestId: "current" };
const assistant = {
  id: "assistant-current",
  role: "assistant",
  requestId: "current",
};

function modelFor(
  records = [progress("current")],
  messages: ComposerPlanMessage[] = [user, assistant],
  activeRequestId = "",
) {
  return buildComposerPlanModel({
    messages,
    activeRequestId,
    getActivityForMessage: (message) => ({
      taskProgress: records.find(
        (record) => record.requestId === message.requestId,
      ),
    }),
  });
}

describe("composer plan selection and authority", () => {
  test("preserves supplied counts, item status and order for a bounded projection", () => {
    const model = modelFor()!;
    expect(model).toMatchObject({
      requestId: "current",
      turnKey: "request:current",
      total: 5,
      completed: 2,
      preview: "Read sources",
      previewStatus: "active",
    });
    expect(model.items.map((item) => [item.id, item.status])).toEqual([
      ["read", "active"],
      ["write", "pending"],
    ]);
    expect(
      modelFor([progress("current", { completed: 0, total: 0 })]),
    ).toMatchObject({
      completed: 0,
      total: 0,
    });
  });

  test("selects matching active request ahead of later assistants in the same turn", () => {
    const other = { role: "assistant", requestId: "other" };
    const messages = [user, assistant, other];
    const records = [progress("current"), progress("other")];
    expect(modelFor(records, messages, "current")?.requestId).toBe("current");
    expect(modelFor(records, messages)?.requestId).toBe("other");
    expect(modelFor([progress("current")], messages, "other")).toBeNull();
    expect(modelFor([progress("current")], messages)?.requestId).toBe(
      "current",
    );
  });

  test("never revives a prior turn, including a stale active request", () => {
    const messages = [assistant, { id: "new-user", role: "user" }];
    expect(modelFor([progress("current")], messages, "current")).toBeNull();
    messages.push({ role: "assistant", id: "new-pending" });
    expect(modelFor([progress("current")], messages)).toBeNull();
    const getActivityForMessage = vi.fn();
    expect(
      buildComposerPlanModel({ messages: [], getActivityForMessage }),
    ).toBeNull();
    expect(getActivityForMessage).not.toHaveBeenCalled();
  });

  test("restores the latest user's request plan when no assistant was persisted", () => {
    const records = [
      progress("older"),
      progress("current", {
        completed: 1,
        activeItem: "",
        items: [
          { id: "blocked", title: "Missing file", status: "blocked", order: 1 },
        ],
      }),
    ];
    const messages = [
      { id: "older-user", role: "user", requestId: "older" },
      { id: "older-assistant", role: "assistant", requestId: "older" },
      user,
    ];

    expect(modelFor(records, messages)).toMatchObject({
      requestId: "current",
      turnKey: "request:current",
      completed: 1,
      items: [{ status: "blocked" }],
    });
    expect(modelFor([progress("older")], messages, "older")).toBeNull();
    expect(
      buildComposerPlanModel({
        messages: [user],
        getActivityForMessage: () => ({ taskProgress: progress("foreign") }),
      }),
    ).toBeNull();
  });

  test("rejects mismatched progress data and accepts signal-only current progress", () => {
    expect(
      buildComposerPlanModel({
        messages: [user, assistant],
        getActivityForMessage: () => ({ taskProgress: progress("foreign") }),
      }),
    ).toBeNull();
    expect(
      modelFor([
        progress("current", {
          items: [],
          summary: "",
          total: 0,
          completed: 0,
        }),
      ]),
    ).toMatchObject({ preview: "Preparing tasks...", items: [] });
  });

  test("uses summary after the active item and never derives completion from a terminal message", () => {
    const record = progress("current", {
      items: [
        { id: "blocked", title: "חסר קובץ", status: "blocked", order: 1 },
      ],
      completed: 0,
    });
    const completedAssistant = { ...assistant, status: "completed" };
    expect(modelFor([record], [user, completedAssistant])).toMatchObject({
      preview: "Prepare the report",
      completed: 0,
      items: [{ status: "blocked", title: "חסר קובץ" }],
    });
    expect(
      modelFor([
        progress("current", {
          ...record,
          summary: "",
          activeItem: "",
        }),
      ])?.preview,
    ).toBe("חסר קובץ");
  });
});

type PlanElement = ContextElement & { open: boolean; scrollTop: number };

describe("composer plan drawer presentation", () => {
  function renderPlan() {
    const dom = createComposerContextDom();
    const drawer = createComposerPlan({
      container: dom.container as unknown as HTMLElement,
      documentRoot: dom.documentRoot as unknown as Document,
    });
    const model = modelFor()!;
    drawer.render(model);
    const details = dom.container.querySelector("details") as PlanElement;
    const body = dom.container.querySelector(
      ".composer-plan-body",
    ) as PlanElement;
    return { ...dom, drawer, model, details, body };
  }

  test("uses native collapsed details and accessible text for every item status", () => {
    const { container, details } = renderPlan();
    expect(container.hidden).toBe(false);
    expect(details.open).toBe(false);
    expect(details.children[0].tagName).toBe("summary");
    expect(container.textContent).toContain("2/5 completed");
    expect(container.textContent).toContain("In progress");
    expect(container.textContent).toContain("Pending");
    expect(
      container.querySelector(".composer-plan-item-title")?.getAttribute("dir"),
    ).toBe("auto");
    expect(
      container.querySelector(".composer-plan-preview")?.getAttribute("dir"),
    ).toBe("auto");
  });

  test("keeps expansion and scroll when steering inserts a same-request user message", () => {
    const { container, drawer, model, details, body } = renderPlan();
    details.open = true;
    body.scrollTop = 73;
    const updated = progress("current", {
      completed: 3,
      items: model.items.map((item) => ({ ...item, status: "done" })),
    });
    const steeredMessages = [
      user,
      {
        id: "steer-new-instruction",
        role: "user",
        requestId: "current",
      },
      assistant,
    ];
    drawer.render(modelFor([updated], steeredMessages, "current"));
    expect(container.querySelector("details")).toBe(details);
    expect(details.open).toBe(true);
    expect(body.scrollTop).toBe(73);
    expect(container.textContent).toContain("3/5 completed");

    drawer.render(modelFor([updated], steeredMessages));
    expect(details.open).toBe(true);
    expect(body.scrollTop).toBe(73);

    const nextMessages = [
      ...steeredMessages,
      {
        id: "user-next",
        role: "user",
        requestId: "next",
      },
      { id: "assistant-next", role: "assistant", requestId: "next" },
    ];
    drawer.render(modelFor([updated, progress("next")], nextMessages, "next"));
    expect(details.open).toBe(false);
    expect(body.scrollTop).toBe(0);
  });

  test.each(["null", "reset"])(
    "%s hides old session/turn data and clears expansion",
    (action) => {
      const { container, drawer, details, body } = renderPlan();
      details.open = true;
      body.scrollTop = 40;
      if (action === "null") drawer.render(null);
      if (action === "reset") drawer.reset();
      expect(container.hidden).toBe(true);
      expect(container.dataset.requestId).toBe("");
      expect(details.open).toBe(false);
      expect(body.scrollTop).toBe(0);
      expect(container.textContent).not.toContain("Read sources");
    },
  );

  test("renders user-controlled plan titles as text and tolerates absent containers", () => {
    const { container, drawer, model } = renderPlan();
    drawer.render({
      ...model,
      summary: "<script>unsafe</script>",
      items: [
        {
          id: "html",
          title: "<img src=x onerror=alert(1)>",
          status: "pending",
          order: 1,
        },
      ],
    });
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(container.querySelector("img")).toBeNull();
    expect(() =>
      createComposerPlan({ container: null }).render(model),
    ).not.toThrow();
  });
});
