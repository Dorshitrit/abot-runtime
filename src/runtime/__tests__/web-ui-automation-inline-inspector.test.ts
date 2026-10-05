import { describe, expect, test } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderAutomationEditor } from "../../web-ui/app/components/automations/editor.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderAutomationTimeline } from "../../web-ui/app/components/automations/timeline.js";

const agent = (id: string) => ({
  kind: "agent", id, title: id, modelProfileId: "local", agentMode: "fast", onFailure: "stop",
  prompt: "Check the input", roleInstructions: "", inputs: {}, tools: [], result: { kind: "text" },
});

const definition = (children: object[]) => ({
  schemaVersion: 1, automationId: "automation-one", revision: 1, title: "", objective: "", inputs: {},
  trigger: { kind: "manual" }, limits: {}, body: { kind: "sequence", id: "root", children },
});

describe("ABot Studio inline step preview", () => {
  test("opens a compact preview below its selected card with explicit modal editing", () => {
    const markup = renderAutomationEditor({
      automations: [], selectedAutomationId: "automation-one", selectedNodeId: "first", runs: [],
      draft: { revision: 1, definition: definition([agent("first"), agent("second")]) },
      catalog: { operations: [], models: [], savedAgents: [] },
      grant: null, validation: null, error: "", feedback: "",
    });
    const card = markup.indexOf('data-graph-item="first"');
    const preview = markup.indexOf('id="automation-step-settings"');
    const nextConnector = markup.indexOf('data-insert-index="1"');
    const nextCard = markup.indexOf('data-graph-item="second"');
    const agents = markup.indexOf('aria-label="Agents"');
    const tools = markup.indexOf('aria-label="Tools"');
    const canvas = markup.indexOf('class="automation-canvas"');
    expect(agents).toBeGreaterThan(-1);
    expect(tools).toBeGreaterThan(agents);
    expect(canvas).toBeGreaterThan(tools);
    expect(card).toBeGreaterThan(-1);
    expect(card).toBeGreaterThan(canvas);
    expect(preview).toBeGreaterThan(card);
    expect(nextConnector).toBeGreaterThan(preview);
    expect(nextCard).toBeGreaterThan(nextConnector);
    expect(markup).not.toContain("data-automation-node-form");
    expect(markup).toContain('data-action="edit-step" aria-haspopup="dialog"');
    expect(markup).toContain("Check the input");
    expect(markup).toContain('aria-expanded="true" aria-controls="automation-step-settings"');
    expect(markup).toContain('data-select-node="" aria-label="Close step preview"');
    expect(markup).toContain('<h3 dir="auto">ABot Automation</h3>');
    expect(markup.slice(agents, canvas)).not.toContain("data-automation-node-form");
  });

  test("keeps selected branch settings inside the fork and run mode read-only", () => {
    const graph = definition([{
      kind: "parallel", id: "fork", branches: [
        { kind: "sequence", id: "left", children: [agent("branch-step")] },
        { kind: "sequence", id: "right", children: [agent("other-branch")] },
      ],
    }, agent("after-fork")]);
    const editor = renderAutomationTimeline(graph, {
      editable: true, selectedNodeId: "branch-step",
      inspectorMarkup: '<section id="automation-step-settings">Settings</section>',
    });
    expect(editor.indexOf('data-graph-item="branch-step"')).toBeLessThan(editor.indexOf('id="automation-step-settings"'));
    expect(editor.indexOf('id="automation-step-settings"')).toBeLessThan(editor.indexOf('class="automation-join"'));
    expect(editor.indexOf('class="automation-join"')).toBeLessThan(editor.indexOf('data-graph-item="after-fork"'));
    expect(editor.match(/automation-inline-inspector-frame/g)).toHaveLength(1);
    const run = renderAutomationTimeline(graph, {
      run: { nodes: [] }, selectedNodeId: "branch-step",
      inspectorMarkup: '<section id="automation-step-settings">Settings</section>',
    });
    expect(run).not.toContain("automation-inline-inspector-frame");
    expect(run).not.toContain("aria-expanded");
  });
});
