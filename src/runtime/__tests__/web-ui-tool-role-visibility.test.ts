import { describe, expect, test } from "vitest";
import {
  buildConversationActivityModel,
  createConversationActivity,
} from "../../web-ui/app/components/conversation-activity.js";
import { ContextElement } from "./support/composer-context-window-dom.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

type ActivityElement = ContextElement & { open: boolean };

function outcome(extra: Record<string, unknown> = {}) {
  return {
    type: "event",
    name: "tool.completed",
    eventSequence: 2,
    requestId: "request-1",
    sessionId: "session-1",
    tool: "read_file",
    ok: true,
    meta: { path: "notes.txt", outputPreview: "Recorded result" },
    ...extra,
  };
}

function roleStage(stage: string) {
  return {
    type: "event",
    name: "runtime.state",
    eventSequence: 1,
    requestId: "request-1",
    sessionId: "session-1",
    stage,
    phase: "working",
  };
}

async function recordings(events: Record<string, unknown>[], streaming = false) {
  const live = createPlanLifecycleHarness();
  events.forEach(live.realtime.handle);
  const restored = createPlanLifecycleHarness({
    sessionId: "session-1",
    messages: [],
    requests: [
      {
        requestId: "request-1",
        status: streaming ? "streaming" : "completed",
        events,
      },
    ],
  });
  await restored.conversationSession.openSession("session-1");
  return [events, live.state.events, restored.state.events];
}

function activity(events: Record<string, unknown>[], streaming = false) {
  const documentRoot = {
    createElement: (tag: string) =>
      Object.assign(new ContextElement(tag), {
        open: false,
        scrollTop: 0,
        scrollHeight: 500,
      }),
    defaultView: { requestAnimationFrame: () => 0 },
  } as unknown as Document;
  const input = { requestId: "request-1", events, streaming };
  const node = createConversationActivity({ documentRoot }).createNode(input)!;
  (node as unknown as ActivityElement).open = true;
  return { node, model: buildConversationActivityModel(input) };
}

function child(root: HTMLElement, selector: string) {
  const found = root.querySelector(selector);
  expect(found).not.toBeNull();
  return found as unknown as ActivityElement;
}

function roleRows(node: HTMLElement): ActivityElement[] {
  return child(node, ".conversation-role-list").children as ActivityElement[];
}

describe("unattributed legacy outcomes remain visible", () => {
  test.each([
    ["tool.completed", "Completed", "Recorded result"],
    ["tool.failed", "Failed", "Recorded failure"],
    ["tool.payload.failed", "Preparation failed", "Recorded failure"],
    ["tool.approval.rejected", "Not approved", "Recorded failure"],
  ])("%s survives Activity, live projection and saved-session restore", async (
    name,
    label,
    evidence,
  ) => {
    const events = [
      outcome({
        name,
        ...(name === "tool.completed" ? {} : { error: "Recorded failure" }),
      }),
    ];
    for (const recorded of await recordings(events)) {
      const { node, model } = activity(recorded);
      expect(model.roleCards).toHaveLength(1);
      expect(model.roleCards[0]).toMatchObject({
        role: "unknown",
        title: "Unattributed actions",
        toolActions: [expect.objectContaining({ legacy: true })],
      });
      const rows = roleRows(node);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.dataset.role).toBe("unknown");
      const row = rows[0] as unknown as HTMLElement;
      expect(child(row, ".conversation-role-title").textContent).toBe(
        "Unattributed actions",
      );
      const details = child(row, ".conversation-tool");
      details.open = true;
      details.dispatch("toggle");
      expect(child(row, ".conversation-tool-status").textContent).toBe(label);
      expect(child(row, ".conversation-tool-target").textContent).toBe("notes.txt");
      expect(row.textContent).toContain(evidence);
      expect(node.querySelector(".conversation-role-toggle")).toBeNull();
    }
  });
});

describe("canonical Researcher attribution", () => {
  const researcherOutcome = () =>
    outcome({
      executionId: "research-1",
      executorRole: "researcher",
      roleCallId: "research-call",
    });

  test("exact Researcher execution identity renders its named actor and avatar", async () => {
    for (const recorded of await recordings([researcherOutcome()])) {
      const { node, model } = activity(recorded);
      expect(model.roleCards).toHaveLength(1);
      expect(model.roleCards[0]).toMatchObject({
        role: "researcher",
        title: "Researcher",
        responsibility: "Investigates assigned questions",
        toolActions: [
          expect.objectContaining({
            executorRole: "researcher",
            roleCallId: "research-call",
          }),
        ],
      });
      const row = roleRows(node)[0] as unknown as HTMLElement;
      expect(child(row, ".conversation-role-title").textContent).toBe("Researcher");
      expect(child(row, ".conversation-role-avatar").textContent).toBe("Rs");
      expect(child(row, ".conversation-tools").getAttribute("aria-label")).toBe(
        "Researcher tool activity",
      );
      expect(child(row, ".conversation-tool-preview").textContent).toBe(
        "Recorded result",
      );
      expect(node.textContent).not.toContain("Unattributed actions");
    }
  });

  test.each(["worker", "researcher"])("tool attribution preserves the explicit active %s stage", async (stage) => {
    const events = [roleStage(stage), researcherOutcome()];
    for (const recorded of await recordings(events, true)) {
      const { node, model } = activity(recorded, true);
      const activeRoles = model.roleCards
        .filter((card) => card.active)
        .map((card) => card.role);
      expect(activeRoles).toEqual([stage]);
      const researcher = model.roleCards.find((card) => card.role === "researcher");
      expect(researcher!.toolActions).toHaveLength(1);
      const row = roleRows(node).find(
        (item) => item.dataset.role === "researcher",
      )!;
      expect(
        child(row as unknown as HTMLElement, ".conversation-tool-target")
          .textContent,
      ).toBe("notes.txt");
      const otherActors = model.roleCards.filter(
        (card) => card.role !== "researcher",
      );
      expect(otherActors.every((card) => !card.toolActions!.length)).toBe(true);
    }
  });

  test.each([undefined, "new-specialist"])("executor %s remains unknown despite Researcher text and activity", async (executorRole) => {
    const events = [
      roleStage("researcher"),
      outcome({
        executionId: "unattributed-1",
        executorRole,
        roleCallId: "researcher-call",
        meta: { path: "researcher-notes.txt", outputPreview: "Researcher result" },
      }),
    ];
    for (const recorded of await recordings(events, true)) {
      const { node, model } = activity(recorded, true);
      const unknown = model.roleCards.find((card) => card.role === "unknown");
      expect(unknown!.toolActions).toHaveLength(1);
      const row = roleRows(node).find((item) => item.dataset.role === "unknown")!;
      expect(
        child(row as unknown as HTMLElement, ".conversation-tool-target")
          .textContent,
      ).toBe("researcher-notes.txt");
    }
  });
});
