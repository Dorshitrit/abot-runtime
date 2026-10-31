import { describe, expect, test, vi } from "vitest";
import { createConversationWorkTimeline, type ConversationWorkTimelineInput } from "../../web-ui/app/components/conversation-work-timeline.js";
import { buildConversationActivityModel } from "../../web-ui/app/components/conversation-activity.js";
import { ContextElement } from "./support/composer-context-window-dom.js";

class TimelineElement extends ContextElement {
  open = false;
  title = "";
  set innerHTML(value: string) { this.textContent = value; }
  get innerHTML() { return this.textContent; }
  override appendChild(child: ContextElement) {
    const previous = child.parentElement;
    if (previous) previous.children.splice(previous.children.indexOf(child), 1);
    return super.appendChild(child);
  }
}

function descendants(root: ContextElement, selector: string): TimelineElement[] {
  return root.children.flatMap((child) => [
    ...(child.matches(selector) ? [child as TimelineElement] : []), ...descendants(child, selector),
  ]);
}
function child(root: ContextElement, selector: string) {
  const node = root.querySelector(selector);
  expect(node).not.toBeNull();
  return node as TimelineElement;
}
const requestId = "request-1";
const event = (name: string, eventSequence: number, fields: Record<string, unknown> = {}) => ({
  type: "event", requestId, name, eventSequence, ...fields,
});
const update = (text = "Progress", sequence = 1) => ({
  id: `update-${sequence}`, role: "assistant", kind: "user_interaction", requestId,
  text, eventSequence: sequence, streaming: false,
});
function setup() {
  const documentRoot = { createElement: (tag: string) => new TimelineElement(tag) } as unknown as Document;
  const onOpenFile = vi.fn();
  const renderer = createConversationWorkTimeline({ documentRoot, onOpenFile, canOpenFile: () => true });
  const render = (input: ConversationWorkTimelineInput = {}) => renderer.createNode({
    requestId, updates: [update()], streaming: true, ...input,
  }) as unknown as TimelineElement;
  return { renderer, render, onOpenFile };
}

const fileOutput = {
  version: 1, location: "agent_work", rootId: `sha256:${"a".repeat(64)}`,
  relativePath: "report.txt", logicalPath: "report.txt", operation: "created",
};
function tools() {
  return [
    event("tool.started", 1, { tool: "read_file", executionId: "read-1", executorRole: "worker", roleCallId: "worker-1", meta: { path: "source.txt" } }),
    event("tool.completed", 2, { tool: "read_file", executionId: "read-1", executorRole: "worker", roleCallId: "worker-1", ok: true,
      meta: { path: "source.txt", outputPreview: "Exact read evidence", lineCount: 3 } }),
    event("tool.completed", 4, { tool: "write_file", executionId: "write-1", executorRole: "reviewer", roleCallId: "reviewer-1", ok: true,
      meta: { path: "report.txt", inputPreview: "Exact authored body", byteCount: 23, fileOutput } }),
  ];
}

describe("unified work timeline rendering", () => {
  test("stays open before a final answer, including waiting, failure and stopped non-streaming states", () => {
    const f = setup();
    for (const name of ["tool.approval.required", "request.failed", "request.cancelled"]) {
      const node = f.render({ streaming: false, events: [event(name, 2)] });
      expect(child(node, ".conversation-work-panel").hidden).toBe(false);
      expect(child(node, ".conversation-work-toggle").hidden).toBe(true);
      expect(node.querySelector(".conversation-role-message")).toBeNull();
    }
    expect(f.renderer.handlesProgressUpdates).toBe(true);
  });

  test("collapses on the first final answer and retains manual reopening across rerenders", () => {
    const f = setup();
    expect(child(f.render(), ".conversation-work-panel").hidden).toBe(false);
    let node = f.render({ hasFinalAnswer: true, streaming: false });
    const oldToggle = child(node, ".conversation-work-toggle");
    expect(oldToggle.hidden).toBe(false);
    expect(oldToggle.getAttribute("aria-expanded")).toBe("false");
    expect(oldToggle.getAttribute("aria-controls")).toBe(child(node, ".conversation-work-panel").id);
    expect(child(node, ".conversation-work-panel").hidden).toBe(true);
    oldToggle.dispatch("click");
    expect(child(node, ".conversation-work-panel").hidden).toBe(false);
    node = f.render({ hasFinalAnswer: true, streaming: false });
    expect(child(node, ".conversation-work-panel").hidden).toBe(false);
    oldToggle.dispatch("click");
    expect(child(f.render({ hasFinalAnswer: true }), ".conversation-work-panel").hidden).toBe(false);
    node = f.render({ hasFinalAnswer: true });
    child(node, ".conversation-work-toggle").dispatch("click");
    expect(child(f.render({ hasFinalAnswer: true }), ".conversation-work-panel").hidden).toBe(true);
  });

  test("isolates expansion by request and resets disclosure state on forget and reset", () => {
    const f = setup();
    const first = f.render({ hasFinalAnswer: true });
    child(first, ".conversation-work-toggle").dispatch("click");
    const second = f.render({ requestId: "request-2", updates: [{ ...update(), requestId: "request-2" }], hasFinalAnswer: true });
    expect(child(second, ".conversation-work-panel").hidden).toBe(true);
    expect(child(f.render({ hasFinalAnswer: true }), ".conversation-work-panel").hidden).toBe(false);
    f.renderer.forget(requestId);
    child(first, ".conversation-work-toggle").dispatch("click");
    expect(child(f.render({ hasFinalAnswer: true }), ".conversation-work-panel").hidden).toBe(true);
    const reopened = f.render({ hasFinalAnswer: true });
    child(reopened, ".conversation-work-toggle").dispatch("click");
    f.renderer.reset();
    expect(child(f.render({ hasFinalAnswer: true }), ".conversation-work-panel").hidden).toBe(true);
  });

  test("keeps all native tool disclosures and file callbacks current after distributing their rows", () => {
    const f = setup();
    const input = { events: tools(), updates: [update("Between tools", 3)] };
    const before = structuredClone(input);
    let node = f.render(input);
    const entries = descendants(node, ".conversation-work-entry");
    expect(entries.map((row) => row.dataset.kind)).toEqual(["tool", "message", "tool"]);
    expect(descendants(node, ".conversation-work-role-title").map((row) => row.textContent)).toEqual(["Worker", "Root agent", "Reviewer"]);
    const original = descendants(node, ".conversation-tool");
    expect(original).toHaveLength(2);
    for (const disclosure of original) { disclosure.open = true; disclosure.dispatch("toggle"); }
    const oldFile = child(node, ".conversation-tool-file-action");
    expect(node.textContent).toContain("Exact read evidence");
    expect(node.textContent).toContain("Exact authored body");
    expect(descendants(node, ".conversation-tool-status").map((row) => row.textContent)).toEqual(["Completed", "Completed"]);
    node = f.render(input);
    expect(descendants(node, ".conversation-tool").map((row) => row.open)).toEqual([true, true]);
    for (const disclosure of original) { disclosure.open = false; disclosure.dispatch("toggle"); }
    oldFile.dispatch("click", { preventDefault() {}, stopPropagation() {} });
    expect(f.onOpenFile).not.toHaveBeenCalled();
    child(node, ".conversation-tool-file-action").dispatch("click", { preventDefault() {}, stopPropagation() {} });
    expect(f.onOpenFile).toHaveBeenCalledWith({ requestId, executionId: "write-1", output: fileOutput }, expect.anything());
    expect(descendants(f.render(input), ".conversation-tool").map((row) => row.open)).toEqual([true, true]);
    f.renderer.forget(requestId);
    expect(descendants(f.render(input), ".conversation-tool").map((row) => row.open)).toEqual([false, false]);
    expect(input).toEqual(before);
  });

  test("preserves delegation and return detail expansion for every recorded entry", () => {
    const f = setup();
    const bound = { callerRole: "supervisor", callerCallId: "root-1", childRole: "planner", childCallId: "planner-1", objective: "Plan the exact task" };
    const events = [event("role.delegated", 1, bound), event("role.delegated", 2, { ...bound, childCallId: "planner-2", objective: "Plan another task" }),
      event("role.returned", 3, { ...bound, outcome: "completed", summary: "Exact first result" }),
      event("role.returned", 4, { ...bound, childCallId: "planner-2", outcome: "completed", summary: "Exact second result" })];
    let node = f.render({ events, updates: [] });
    const details = descendants(node, ".conversation-role-history-item");
    expect(details).toHaveLength(4);
    for (const detail of details) { detail.open = true; detail.dispatch("toggle"); }
    node = f.render({ events, updates: [] });
    expect(descendants(node, ".conversation-role-history-item").map((row) => row.open)).toEqual([true, true, true, true]);
    expect(node.textContent).toContain("Plan the exact task");
    expect(node.textContent).toContain("Exact second result");
    f.renderer.reset();
    expect(descendants(f.render({ events, updates: [] }), ".conversation-role-history-item").every((row) => !row.open)).toBe(true);
  });

  test("retains memory, basket, skills, sources and safe mixed-direction messages inside the collapsible panel", () => {
    const f = setup();
    const events = [event("memory.retrieval.started", 1), event("memory.retrieval.completed", 2),
      event("runtime.stage", 3, { stage: "information_basket", phase: "discovery_found" }),
      event("runtime.stage", 4, { stage: "supervisor", phase: "skills", summary: "Read exact Skill" }),
      event("tool.completed", 6, { tool: "read_file", executionId: "unknown", executorRole: "made-up-role", ok: true })];
    const model = buildConversationActivityModel({ requestId, events });
    model.sources = [{ version: 1, id: "source-1", callId: "call-1", operation: "search", sources: [{
      url: "https://example.test/report", title: "Exact source", retrieval: "retrieved", presentation: "content", contentTruncated: false,
    }] }];
    const node = f.render({ events, updates: [update("**שלום** <script>untrusted()</script>", 5)], summaryModel: model, hasFinalAnswer: true });
    const panel = child(node, ".conversation-work-panel");
    expect(panel.hidden).toBe(true);
    for (const selector of [".conversation-memory-activity", ".conversation-basket-collection", ".conversation-skill-collection", ".conversation-sources"])
      expect(panel.querySelector(selector)).not.toBeNull();
    const message = child(panel, ".conversation-work-message");
    expect(message.classList.contains("rtl-text")).toBe(true);
    expect(message.textContent).toContain("<strong>שלום</strong>");
    expect(message.textContent).toContain("&lt;script&gt;");
    expect(message.querySelector("button")).toBeNull();
    expect(message.querySelector("time")).toBeNull();
    expect(panel.textContent).toContain("Unattributed actions");
    expect(child(panel, ".conversation-source-link").getAttribute("aria-label")).toContain("https://example.test/report");
    child(node, ".conversation-work-toggle").dispatch("click");
    expect(panel.hidden).toBe(false);
  });

  test("does not alternate root labels for EA interactions and supervisor-owned tools", () => {
    const f = setup();
    const events = [event("tool.completed", 2, { tool: "read_file", executionId: "read-1", executorRole: "supervisor", ok: true })];
    const node = f.render({ events, updates: [update("Starting", 1), update("Finished", 3)] });
    expect(descendants(node, ".conversation-work-role-title").map((row) => row.textContent)).toEqual(["Root agent"]);
    expect(f.renderer.createNode({ requestId, events: [], updates: [] })).toBeNull();
  });
});

test("Agents timeline omits repeated generic processing rows while keeping skills and tools", () => {
  const f = setup();
  const processing = (sequence: number) => event("Processing the request...", sequence, { stage: "supervisor", phase: "working" });
  const events = [processing(1), event("Read project instructions", 2, { stage: "supervisor", phase: "skills" }), processing(3),
    event("tool.completed", 4, { tool: "read_file", executionId: "read-1", executorRole: "supervisor", ok: true }), processing(5)];
  const before = structuredClone(events);
  const node = f.render({ events, updates: [] });
  expect(node.textContent).not.toContain("Processing The Request");
  expect(node.textContent).toContain("Read Project Instructions");
  expect(descendants(node, ".conversation-work-entry").map((row) => row.dataset.kind)).toEqual(["skill", "tool"]);
  expect(descendants(node, ".conversation-tool")).toHaveLength(1);
  expect(events).toEqual(before);
});
