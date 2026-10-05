import { describe, expect, test } from "vitest";
import { buildToolCompletedEventMetadata, buildToolStartEventMetadata } from "../../capabilities/tool-event-metadata.js";
import type { ToolDefinition } from "../../capabilities/tool-types.js";
import { createAutomationBuilderToolModule } from "../capabilities/automation-builder/tool-module.js";
import { AUTOMATION_TOOL_EVENT_PRESENTATION } from "../capabilities/automations/event-presentation.js";
import { createConversationTools } from "../../web-ui/app/components/conversation-tools.js";
import { projectToolActivityEvent } from "../../web-ui/app/lib/tool-activity-event.js";
import { buildConversationToolActions } from "../../web-ui/app/lib/tool-activity-model.js";
import { ContextElement } from "./support/composer-context-window-dom.js";

function event(meta: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return { name: "tool.completed", requestId: "request", executionId: "execution",
    eventSequence: 2, tool: "automations", ok: true, meta, ...overrides };
}

function declaredEvent(params: Record<string, unknown>, output: string,
  overrides: Record<string, unknown> = {}) {
  const tool = overrides.tool === "automation_builder" ? "automation_builder" : "automations";
  const eventPresentation = tool === "automation_builder"
    ? createAutomationBuilderToolModule(() => { throw new Error("service_not_invoked"); }, async () => {}).definition.eventPresentation
    : AUTOMATION_TOOL_EVENT_PRESENTATION;
  const definition: ToolDefinition = { name: tool, params: {}, routingCapability: "semantic_mutation",
    executionEffect: "read_only", eventPresentation };
  const call = { tool, params };
  const meta = overrides.name === "tool.started"
    ? buildToolStartEventMetadata(call, definition)
    : buildToolCompletedEventMetadata(call, { tool, ok: overrides.ok !== false,
      output, producedNewInformation: true, progress: false }, definition);
  return event(meta || {}, { tool, ...overrides });
}

function actions(events: Record<string, unknown>[]) {
  return buildConversationToolActions({ requestId: "request", events, streaming: false });
}

function render(events: Record<string, unknown>[]) {
  const documentRoot = { createElement: (tag: string) =>
    Object.assign(new ContextElement(tag), { open: false, title: "" }) } as unknown as Document;
  return createConversationTools({ documentRoot }).createNode({ requestId: "request", actions: actions(events) })!;
}

// Fixtures use the modules' existing declarative event projection, without executing them.
describe("automation tool activity display", () => {
  test.each([
    ["browse_catalog", "Browse tools"], ["catalog", "Browse tools"],
    ["prepare_draft", "Prepare draft"], ["list_drafts", "List drafts"],
    ["read_draft", "Read draft"], ["create_draft", "Create draft"],
    ["create_automation_draft", "Create draft"], ["apply_automation_draft_changes", "Update draft"],
    ["validate_draft", "Validate draft"], ["save_agent", "Save agent"],
    ["add_saved_agent", "Add saved agent"],
  ])("%s uses its declared action instead of the generic tool name", (action, title) => {
    const events = [declaredEvent({ action }, "{}")];
    expect(projectToolActivityEvent(events[0]!)!.activityTitle).toBe(title);
    expect(actions(events)[0]).toMatchObject({ title, target: "", status: "completed" });
    expect(render(events).querySelector(".conversation-tool-summary")!.textContent).toContain(title);
  });

  test("a builder lifecycle retains submitted inputs and raw returned excerpt", () => {
    const params = { action: "apply_automation_draft_changes", automationId: "draft-1", expectedRevision: 4,
      planJson: '{"version":1,"commands":[]}' };
    const output = '{"automationId":"draft-1","revision":5}';
    const events = [declaredEvent(params, "", { tool: "automation_builder", name: "tool.started", eventSequence: 1 }),
      declaredEvent(params, output, { tool: "automation_builder" })];
    const result = actions(events)[0]!;
    expect(result).toMatchObject({ target: "draft-1", preview: output, received: [], executed: true });
    expect(result.sent).toContainEqual({ label: "Automation ID", value: "draft-1" });
    expect(result.sent).toContainEqual({ label: "Expected revision", value: "4" });
    expect(result.sent).toContainEqual({ label: "Content excerpt", value: params.planJson });
    expect(result.sent).toContainEqual({ label: "Content characters", value: String(params.planJson.length) });
    const rendered = render(events);
    expect(rendered.textContent).toContain(output);
    expect(rendered.textContent).toContain("Expected revision4");
  });

  test("a created draft uses its requested title without extracting returned identity or revision", () => {
    const output = '{"automationId":"new-draft","revision":1}';
    const events = [declaredEvent({ action: "create_automation_draft", title: "Daily news", planJson: "{}" },
      output, { tool: "automation_builder" })];
    const result = actions(events)[0]!;
    expect(result).toMatchObject({ target: "Daily news", preview: output, received: [] });
    expect(result.sent.some((field) => field.label === "Automation ID")).toBe(false);
    expect(render(events).querySelector(".conversation-tool-target")!.textContent).toBe("Daily news");
  });

  test("catalog results stay bounded text instead of inferred counts or pagination", () => {
    const output = JSON.stringify({ operations: [{ toolName: "example", operationId: "read" }], nextOffset: 15 });
    const result = actions([declaredEvent({ action: "browse_catalog", view: "index", offset: 10 }, output)])[0]!;
    expect(result.sent).toContainEqual({ label: "Offset", value: "10" });
    expect(result.sent).toContainEqual({ label: "View", value: "index" });
    expect(result.received).toEqual([]);
    expect(result.preview).toBe(output);
  });

  test("saved agent output is not mistaken for the submitted agent selection", () => {
    const saved = actions([declaredEvent({ action: "save_agent", automationId: "draft-1", nodeId: "step-1" },
      '{"agentId":"new-agent","revision":1}')])[0]!;
    const reused = actions([declaredEvent({ action: "add_saved_agent", agentId: "selected-agent" }, "{}")])[0]!;
    expect(saved.sent.some((field) => field.label === "Agent ID")).toBe(false);
    expect(saved.received).toEqual([]);
    expect(saved.preview).toContain("new-agent");
    expect(reused.sent).toContainEqual({ label: "Agent ID", value: "selected-agent" });
  });

  test("a failed builder call shows its returned error without claiming a saved revision", () => {
    const output = '{"code":"automation_batch_alias_target_invalid","path":"plan.commands.0.as"}';
    const events = [declaredEvent({ action: "apply_automation_draft_changes", automationId: "draft-1",
      expectedRevision: 4, planJson: "{}" }, output, { tool: "automation_builder", ok: false })];
    expect(actions(events)[0]).toMatchObject({ status: "failed", target: "draft-1", received: [], preview: output });
    expect(render(events).textContent).toContain("plan.commands.0.as");
  });

  test("concurrent actions and replay preserve each exact input/output pair", () => {
    const a = { action: "read_draft", automationId: "one" };
    const b = { action: "apply_automation_draft_changes", automationId: "two", expectedRevision: 8 };
    const events = [declaredEvent(a, "", { name: "tool.started", executionId: "a", eventSequence: 1 }),
      declaredEvent(b, "", { name: "tool.started", executionId: "b", eventSequence: 2 }),
      declaredEvent(b, '{"revision":9}', { executionId: "b", eventSequence: 3 }),
      declaredEvent(a, '{"draft":{"revision":2}}', { executionId: "a", eventSequence: 4 })];
    const result = actions(events);
    expect(result.map(({ target, title, preview }) => ({ target, title, preview }))).toEqual([
      { target: "one", title: "Read draft", preview: '{"draft":{"revision":2}}' },
      { target: "two", title: "Update draft", preview: '{"revision":9}' },
    ]);
    expect(actions(JSON.parse(JSON.stringify([...events, ...events])))).toEqual(result);
  });

  test("only declared bounded input and output excerpts reach the activity", () => {
    const events = [declaredEvent({ action: "create_automation_draft", title: "t".repeat(300),
      planJson: "p".repeat(1000), prompt: "PRIVATE PROMPT", unknown: "PRIVATE VALUE" },
      "z".repeat(1500), { tool: "automation_builder" })];
    const result = actions(events)[0]!;
    expect(result.target).toHaveLength(160);
    expect(result.sent.find((field) => field.label === "Content excerpt")!.value).toHaveLength(500);
    expect(result.sent).toContainEqual({ label: "Content characters", value: "1000" });
    expect(result.preview).toHaveLength(1200);
    expect(result.previewTruncated).toBe(true);
    expect(result.partial).toBe(false);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(actions([event({ automationAction: "read_draft", expectedRevision: -1 })])[0]!.sent)
      .not.toContainEqual({ label: "Expected revision", value: "-1" });
  });

  test("untrusted titles and returned text remain inert and directionally isolated", () => {
    const title = '<img src=x onerror="alert(1)"> חדשות';
    const rendered = render([declaredEvent({ action: "create_draft", title }, title)]);
    expect(rendered.querySelector("img")).toBeNull();
    expect(rendered.querySelector("script")).toBeNull();
    expect(rendered.querySelector(".conversation-tool-target")!.textContent).toBe(title);
    expect(rendered.querySelector(".conversation-tool-target")!.getAttribute("dir")).toBe("auto");
    expect(rendered.querySelector(".conversation-tool-preview")!.textContent).toBe(title);
  });

  test("old summarized metadata never becomes a guessed action or target", () => {
    const result = actions([event({ params: { action: "string(len=10)", automationId: "string(len=36)",
      planJson: "string(len=2189)" }, mutationEvidence: true })])[0]!;
    expect(result).toMatchObject({ title: "Automations", target: "", sent: [], received: [], preview: "" });
    expect(render([event({})]).textContent).toContain("No additional details were recorded.");
  });

  test("automation-shaped metadata leaves other plugin displays unchanged", () => {
    const original = event({ path: "notes.txt", outputPreview: "recorded text" }, { tool: "read_file" });
    const extra = { ...original, meta: { ...original.meta, automationAction: "create_automation_draft",
      automationTitle: "Other title", automationId: "other", expectedRevision: 4 } };
    expect(projectToolActivityEvent(extra)).toEqual(projectToolActivityEvent(original));
    expect(actions([extra])).toEqual(actions([original]));
  });
});
