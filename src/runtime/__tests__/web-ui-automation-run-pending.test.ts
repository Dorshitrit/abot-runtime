import { expect, test } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderAutomationEditorActions } from "../../web-ui/app/components/automations/editor-actions.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderAutomationRun } from "../../web-ui/app/components/automations/run.js";

function runButtons(pending: Record<string, unknown>) {
  const current = { id: "one", status: "paused", publishedRevision: 1 };
  const snapshot = { automations: [current], selectedAutomationId: "one", selectedRunId: "old",
    selectedNodeId: "", runs: [], run: { id: "old", automationId: "one", status: "succeeded" },
    mutation: "", loading: false, runStartPending: false, ...pending };
  const editor = renderAutomationEditorActions(snapshot, { current, canDeleteDraft: false,
    runUnavailable: false, activateUnavailable: false });
  const run = renderAutomationRun(snapshot);
  return [editor.match(/<button[^>]*data-action="run"[^>]*>[\s\S]*?<\/button>/)?.[0],
    run.match(/<button[^>]*data-action="rerun"[^>]*>[\s\S]*?<\/button>/)?.[0]];
}

test("both manual start controls expose immediate pending feedback and are disabled", () => {
  for (const button of runButtons({ runStartPending: true })) {
    expect(button).toContain(" disabled");
    expect(button).toContain('aria-busy="true"');
    expect(button).toContain("Starting…");
  }
});

test.each([{ loading: true }, { mutation: "Publication" }])(
  "manual start controls cannot run while the selected state is busy: %j", (pending) => {
    for (const button of runButtons(pending)) {
      expect(button).toContain(" disabled");
      expect(button).not.toContain("Starting…");
    }
  },
);

test("manual start controls recover their usual labels and availability after settlement", () => {
  const buttons = runButtons({});
  for (const button of buttons) {
    expect(button).not.toContain(" disabled");
    expect(button).not.toContain("aria-busy");
  }
  expect(buttons[0]).toContain("Run now");
  expect(buttons[1]).toContain("Run again");
});
