import { describe, expect, test } from "vitest";
import {
  buildToolCompletedEventMetadata,
  buildToolStartEventMetadata,
} from "../../capabilities/tool-event-metadata.js";
import type { ToolDefinition } from "../../capabilities/tool-types.js";
import { createKnowledgeSkillsToolModule } from "../capabilities/knowledge-skills/tool-module.js";
import { createConversationTools } from "../../web-ui/app/components/conversation-tools.js";
import { projectToolActivityEvent } from "../../web-ui/app/lib/tool-activity-event.js";
import { buildConversationToolActions } from "../../web-ui/app/lib/tool-activity-model.js";
import { enrichEventPayload } from "../events/event-status.js";
import { buildConversationActivityModel } from "../../web-ui/app/components/conversation-activity.js";
import { createConversationRoleCards } from "../../web-ui/app/components/conversation-role-cards.js";
import { ContextElement } from "./support/composer-context-window-dom.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

const definition: ToolDefinition = {
  ...createKnowledgeSkillsToolModule().definition,
  params: {},
  executionEffect: "read_only",
};

function declaredEvent(
  params: Record<string, unknown>,
  skillTitle?: string,
  overrides: Record<string, unknown> = {},
) {
  const call = { tool: "abot_skills", params };
  const output = "PRIVATE SKILL BODY";
  const meta = overrides.name === "tool.started"
    ? buildToolStartEventMetadata(call, definition)
    : buildToolCompletedEventMetadata(call, {
        tool: call.tool,
        ok: overrides.ok !== false,
        output,
        producedNewInformation: true,
        progress: false,
        data: { skillTitle, body: output },
      }, definition);
  return {
    type: "event",
    name: "tool.completed",
    eventSequence: 2,
    requestId: "request-1",
    sessionId: "session-1",
    executionId: "skill-read-1",
    executorRole: "worker",
    roleCallId: "worker-1",
    tool: call.tool,
    ok: true,
    ...overrides,
    meta: meta || {},
  };
}

function actions(events: Record<string, unknown>[], streaming = false) {
  return buildConversationToolActions({
    requestId: "request-1", events, streaming,
  });
}

function render(events: Record<string, unknown>[]) {
  const documentRoot = {
    createElement: (tag: string) =>
      Object.assign(new ContextElement(tag), { open: false, title: "" }),
  } as unknown as Document;
  return createConversationTools({ documentRoot }).createNode({
    requestId: "request-1", actions: actions(events),
  })!;
}

function savedSession(events: Record<string, unknown>[], status = "completed") {
  return {
    sessionId: "session-1",
    messages: [{
      id: "answer", role: "assistant", content: "Saved answer",
      requestId: "request-1",
    }],
    requests: [{
      requestId: "request-1", status, events,
      ...(status === "completed"
        ? { finalState: { status, output: "Saved answer" } }
        : {}),
    }],
  };
}

describe("knowledge Skill tool activity", () => {
  test("uses declared action metadata for LIST without inventing a Skill target", () => {
    const event = declaredEvent({ action: "list_skills" });
    expect(actions([event])[0]).toMatchObject({
      title: "List skills", target: "", status: "completed", preview: "",
    });
    expect(render([event]).querySelector(".conversation-tool-target")).toBeNull();
    expect(JSON.stringify(event.meta)).not.toContain("PRIVATE");
  });

  test("one multiple-read activity shows requested IDs and then canonical names", () => {
    const params = { action: "read_skills", skillIds: ["abot-studio", "computer-use"] };
    const started = declaredEvent(params, undefined, { name: "tool.started", eventSequence: 1, ok: undefined });
    const completed = declaredEvent(params, "ABot Studio, Computer Use");
    expect(actions([started], true)[0]).toMatchObject({
      title: "Read skills", target: "abot-studio, computer-use", status: "running",
    });
    expect(actions([started, completed])).toHaveLength(1);
    expect(actions([started, completed])[0]).toMatchObject({
      title: "Read skills", target: "ABot Studio, Computer Use", status: "completed", preview: "",
    });
    expect(JSON.stringify(actions([started, completed]))).not.toContain("PRIVATE");
  });

  test.each([["create_skill", "Create skill"], ["update_skill", "Edit skill"]])(
    "%s displays one named activity without the authored body", (action, title) => {
      const params = { action, name: "Personal workflow", content: "PRIVATE AUTHORING BODY",
        ...(action === "update_skill" ? { skillId: "personal-one" } : {}) };
      const started = declaredEvent(params, undefined, { name: "tool.started", eventSequence: 1, ok: undefined });
      const completed = declaredEvent(params, "Saved personal workflow");
      completed.meta = { ...completed.meta, savedSkillId: "personal-one" };
      expect(actions([started], true)[0]).toMatchObject({ title, target: "Personal workflow", status: "running" });
      const result = actions([started, completed]);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ title, target: "Saved personal workflow", status: "completed", preview: "" });
      expect(result[0]!.sent).toContainEqual({ label: "Skill ID", value: "personal-one" });
      expect(JSON.stringify(result)).not.toContain("PRIVATE");
    },
  );

  test("fills the existing READ row with the canonical result title", () => {
    const params = { action: "read_skill", skillId: "abot-studio" };
    const started = declaredEvent(params, undefined, {
      name: "tool.started", eventSequence: 1, ok: undefined,
    });
    const completed = declaredEvent(params, "ABot Studio");
    const pending = actions([started], true)[0]!;
    expect(pending).toMatchObject({
      title: "Read skill", target: "abot-studio", status: "running",
      executorRole: "worker", roleCallId: "worker-1", preview: "",
    });
    const settled = actions([started, completed]);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      id: pending.id, title: "Read skill", target: "ABot Studio",
      status: "completed", executed: true, preview: "", previewTruncated: false,
    });
    expect(settled[0]!.sent).toContainEqual({
      label: "Skill reference", value: "abot-studio",
    });
    expect(render([started, completed]).querySelector(".conversation-tool-target")!.textContent)
      .toBe("ABot Studio");
    expect(render([started, completed]).querySelector(".conversation-tool-preview")).toBeNull();
    expect(JSON.stringify(settled)).not.toContain("PRIVATE");
  });

  test.each([
    ["tool.completed", false, "failed"],
    ["tool.completed", undefined, "incomplete"],
    ["tool.failed", false, "failed"],
  ])("keeps the requested ID when %s has ok=%s", (name, ok, status) => {
    const event = declaredEvent(
      { action: "read_skill", skillId: "missing-skill" },
      "Unconfirmed title",
      { name, ok, error: "knowledge_skill_not_found" },
    );
    expect(actions([event])[0]).toMatchObject({
      title: "Read skill", target: "missing-skill", status, preview: "",
    });
    expect(actions([event])[0]!.received).toContainEqual({
      label: "Error", value: "knowledge_skill_not_found",
    });
    expect(render([event]).textContent).not.toContain("Unconfirmed title");
  });

  test.each(["read_skill", "read_skills"].flatMap((action) =>
    [129, 160].map((length) => ({ action, length })),
  ))("$action preserves a full $length-character name in pending and failed activity", ({ action, length }) => {
    const name = "ש".repeat(length - 4) + "סוף!";
    const params = action === "read_skill" ? { action, skillId: name } : { action, skillIds: [name] };
    const started = declaredEvent(params, undefined, { name: "tool.started", eventSequence: 1, ok: undefined });
    const failed = declaredEvent(params, undefined, { ok: false, error: "knowledge_skill_not_found" });
    const label = action === "read_skill" ? "Skill reference" : "Skill references";
    for (const events of [[started], [started, failed]]) {
      const activity = actions(events, events.length === 1)[0]!;
      expect(activity.target).toBe(name);
      expect(activity.sent).toContainEqual({ label, value: name });
      expect(render(events).textContent).toContain(name);
      expect(JSON.stringify(activity)).not.toContain("PRIVATE");
    }
  });

  test("never uses a body or output preview to derive identity or display content", () => {
    const event = declaredEvent({ action: "read_skill", skillId: "computer-use" });
    const augmented = {
      ...event,
      meta: {
        ...event.meta, body: "PRIVATE BODY", outputPreview: "PRIVATE PREVIEW",
        outputPreviewTruncated: true,
      },
    };
    expect(actions([augmented])[0]).toMatchObject({
      target: "computer-use", preview: "", previewTruncated: false,
    });
    expect(JSON.stringify(projectToolActivityEvent(augmented))).not.toContain("PRIVATE");
    const unknown = { ...event, meta: { params: { action: "read_skill", skillId: "guessed" } } };
    expect(actions([unknown])[0]).toMatchObject({
      title: "Abot Skills", target: "", sent: [],
    });
  });

  test("bounds display identities and renders canonical titles as inert text", () => {
    const params = { action: "read_skill", skillId: "i".repeat(300) };
    const long = declaredEvent(params, "t".repeat(300));
    expect(actions([long])[0]!.target).toHaveLength(160);
    expect(actions([long])[0]!.sent.find((field) => field.label === "Skill reference")!.value)
      .toHaveLength(160);
    const title = '<img src=x onerror="alert(1)"> Skill';
    const node = render([declaredEvent(params, title)]);
    expect(node.querySelector("img")).toBeNull();
    expect(node.querySelector(".conversation-tool-target")!.textContent).toBe(title);
    expect(node.querySelector(".conversation-tool-target")!.getAttribute("dir")).toBe("auto");
  });

  test("live, saved and overlapping replay retain one named activity", async () => {
    const params = { action: "read_skill", skillId: "computer-use" };
    const events = [
      declaredEvent(params, undefined, { name: "tool.started", eventSequence: 1, ok: undefined }),
      declaredEvent(params, "Computer Use"),
    ];
    const live = createPlanLifecycleHarness();
    events.forEach(live.realtime.handle);
    const stored = createPlanLifecycleHarness(savedSession(events));
    await stored.conversationSession.openSession("session-1");
    const overlap = createPlanLifecycleHarness(
      savedSession(events.slice(0, 1), "streaming"),
      events.map((event, index) => ({ ...event, seqNo: index + 2 })),
    );
    await overlap.conversationSession.openSession("session-1");
    overlap.realtime.handle({ ...events[1], seqNo: 4 });
    for (const harness of [live, stored, overlap]) {
      expect(harness.state.events).toHaveLength(2);
      expect(actions(harness.state.events)).toEqual(actions(events));
      expect(JSON.stringify(harness.state.events)).not.toContain("PRIVATE");
    }
    expect(overlap.state.lastSeqByRequest.get("request-1")).toBe(4);
  });

  test("parallel READs keep execution identity through duplicate and reordered replay", () => {
    const a = { action: "read_skill", skillId: "abot-studio" };
    const b = { action: "read_skill", skillId: "computer-use" };
    const events = [
      declaredEvent(a, undefined, { name: "tool.started", eventSequence: 1 }),
      declaredEvent(b, undefined, { name: "tool.started", executionId: "read-2", eventSequence: 2 }),
      declaredEvent(b, "Computer Use", { executionId: "read-2", eventSequence: 3 }),
      declaredEvent(a, "ABot Studio", { eventSequence: 4 }),
    ];
    const expected = actions(events);
    expect(expected.map(({ target }) => target)).toEqual(["ABot Studio", "Computer Use"]);
    expect(expected[0]!.id).not.toBe(expected[1]!.id);
    expect(actions([events[3]!, events[2]!, ...events, events[3]!])).toEqual(expected);
  });

  test.each(["read_file", "automations"])("Skill metadata leaves %s activity unchanged", (tool) => {
    const event = {
      ...declaredEvent({ action: "list_skills" }),
      tool,
      meta: {
        path: "notes.txt", outputPreview: "ordinary result",
        automationAction: "read_draft", automationId: "draft-1",
      },
    };
    const augmented = {
      ...event,
      meta: { ...event.meta, skillAction: "read_skill", skillId: "other", skillTitle: "Other title" },
    };
    expect(projectToolActivityEvent(augmented)).toEqual(projectToolActivityEvent(event));
    expect(actions([augmented])).toEqual(actions([event]));
  });
});

describe("Supervisor Skill lookup presentation", () => {
  const lookup = {
    type: "event", name: "runtime.state", stage: "supervisor", phase: "skills",
    message: "Skill lookup failed: knowledge_skill_not_found",
    requestId: "request-1", sessionId: "session-1", eventSequence: 1,
  };

  test.each([false, true])("a missing Skill stays neutral live and after replay (enriched=%s)", async (enriched) => {
    const event = enriched ? enrichEventPayload(lookup) : lookup;
    const original = JSON.stringify(event);
    const live = createPlanLifecycleHarness();
    live.realtime.handle(event);
    const saved = createPlanLifecycleHarness(savedSession([event]));
    await saved.conversationSession.openSession("session-1");
    const documentRoot = {
      createElement: (tag: string) => new ContextElement(tag),
    } as unknown as Document;
    for (const harness of [live, saved]) {
      const model = buildConversationActivityModel({
        requestId: "request-1", events: harness.state.events,
      });
      expect(model.failureCount).toBe(0);
      expect(model.events).toHaveLength(1);
      expect(model.events[0]).toMatchObject({ name: "Skill not found", tone: "neutral" });
      expect(model.roleCards).toHaveLength(1);
      expect(model.roleCards[0]!.tone).not.toBe("failed");
      const card = createConversationRoleCards({ documentRoot }).createNode({
        requestId: "request-1", cards: model.roleCards,
        timeline: documentRoot.createElement("div"), hasTimeline: true,
      });
      expect(card.textContent).toMatch(/Skill not found/i);
      expect(card.textContent).not.toContain("lookup failed");
      expect(card.querySelector(".conversation-role-error")).toBeNull();
    }
    expect(JSON.stringify(event)).toBe(original);
    expect(original).toContain("knowledge_skill_not_found");
  });

  test.each([
    { message: "Skill lookup failed: knowledge_skill_store_unavailable" },
    { phase: "execution" },
    { name: "request.failed", status: "failed" },
  ])("does not hide other failures: %j", (override) => {
    const event = enrichEventPayload({ ...lookup, ...override });
    const live = createPlanLifecycleHarness();
    live.realtime.handle(event);
    const model = buildConversationActivityModel({
      requestId: "request-1", events: live.state.events,
    });
    expect(model.failureCount).toBe(1);
    expect(model.events[0]!.tone).toBe("failed");
  });
});
