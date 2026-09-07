import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module has no declaration surface.
import { createConversationSchedule } from "../../web-ui/app/components/conversation-schedule.js";
import { normalizeConversationMessage } from "../../web-ui/app/controllers/conversation-session-controller.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { renderScheduleDetails } from "../../web-ui/app/components/schedules/details.js";
import { ContextElement } from "./support/composer-context-window-dom.js";

function documentFixture() {
  return {
    createElement: (tag: string) =>
      Object.assign(new ContextElement(tag), { open: false }),
  };
}

describe("scheduled invocation card", () => {
  test("renders an exact historical prompt collapsed, preserves disclosure through rerender and links the canonical Job", () => {
    const open = vi.fn();
    const renderer = createConversationSchedule({
      documentRoot: documentFixture(),
      onOpenJob: open,
    });
    const message = normalizeConversationMessage({
      role: "user",
      content: '<script>alert("prompt")</script> שלום',
      requestId: "request-1",
      schedule: {
        jobId: "job-1",
        runId: "run-1",
        title: "Original title",
        scheduledAt: "2026-09-07T06:00:00Z",
        triggerType: "schedule",
      },
    });
    const node = renderer.createNode(message) as ContextElement;
    const details = node.querySelector("details") as ContextElement & {
      open: boolean;
    };
    expect(details.open).toBe(false);
    expect(node.querySelector("pre")?.textContent).toBe(
      '<script>alert("prompt")</script> שלום',
    );
    expect(node.querySelector("script")).toBeNull();
    expect(node.querySelector("summary")?.textContent).not.toContain(
      message.text,
    );
    node.querySelector("button")?.dispatch("click");
    expect(open).toHaveBeenCalledWith("job-1", "run-1");
    details.open = true;
    details.dispatch("toggle");
    expect(renderer.createNode(message).querySelector("details").open).toBe(
      true,
    );
    renderer.reset();
    expect(renderer.createNode(message).querySelector("details").open).toBe(
      false,
    );
  });

  test("does not replace ordinary user or assistant messages with cards", () => {
    const renderer = createConversationSchedule({
      documentRoot: documentFixture(),
    });
    expect(
      renderer.createNode({ role: "user", text: "Ordinary message" }),
    ).toBeNull();
    expect(
      renderer.createNode({
        role: "assistant",
        schedule: { jobId: "job-1", runId: "run-1" },
      }),
    ).toBeNull();
  });
});

describe("schedule run history", () => {
  test("keeps recorded model, mode, zone and revision after the Job changes", () => {
    const root = {
      innerHTML: "",
      classList: { add: vi.fn(), remove: vi.fn() },
      querySelectorAll: () => [],
      querySelector: () => ({ addEventListener: vi.fn() }),
    };
    renderScheduleDetails({
      root,
      actions: {},
      snapshot: {
        selectedId: "job-1",
        sessions: [],
        jobs: [
          {
            id: "job-1",
            title: "Edited",
            sessionId: "session-1",
            modelProfileId: "new-profile",
            agentMode: "deep",
            timeZone: "Asia/Jerusalem",
            state: "active",
            schedule: { kind: "daily", at: "09:00" },
            revision: 3,
          },
        ],
        runs: [
          {
            id: "history-run",
            jobId: "job-1",
            modelProfileId: "recorded-profile",
            agentMode: "fast",
            timeZone: "UTC",
            jobRevision: 1,
            prompt: "Original instruction",
            scheduledAt: "2026-09-07T06:00:00Z",
            status: "succeeded",
            trigger: "schedule",
          },
        ],
      },
    });
    const historicalHtml = root.innerHTML.split('data-run-id="history-run"')[1];
    expect(historicalHtml).toContain("recorded-profile");
    expect(historicalHtml).toContain("fast");
    expect(historicalHtml).toContain("UTC");
    expect(historicalHtml).not.toContain("new-profile");
    expect(historicalHtml).not.toContain("Asia/Jerusalem");
  });
});
