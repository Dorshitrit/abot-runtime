import { formDefinition } from "./support/agent-authoring-form-fixture.js";
import { agentBudgetPresets } from "../agents/authoring-budgets.js";
import { describe, expect, test, vi } from "vitest";
import { createAgentRequests } from "../../web-ui/app/services/runtime-web-client/agents.js";
import { assertAgentDraftPreference } from "../../web-ui/client-state/agent-draft-preference.js";
import { readWorkspaceRoute, workspaceRouteUrl } from "../../web-ui/app/lib/workspace-route.js";
// @ts-expect-error Browser-only module.
import { emptyAgentDraft, validateAgentDraft, agentDraftLimits, agentDraftFromDetail } from "../../web-ui/app/components/agents/onboarding-options.js";
// @ts-expect-error Browser-only module.
import { renderAgentOnboarding } from "../../web-ui/app/components/agents/onboarding.js";
// @ts-expect-error Browser-only module.
import { createAgentDrafts } from "../../web-ui/app/components/agents/drafts.js";
// @ts-expect-error Browser-only module.
import { agentOrbitPoint } from "../../web-ui/app/components/agents/orbits.js";
// @ts-expect-error Browser-only module.
import { agentHoverWork, agentPortrait, agentColor } from "../../web-ui/app/components/agents/appearance.js";
// @ts-expect-error Browser-only module.
import { renderAgentMessages, renderAgentApprovals, renderAgentConversation, renderAgentTaskState, renderTaskControls, renderAgentSessions } from "../../web-ui/app/components/agents/conversation.js";
// @ts-expect-error Browser-only module.
import { requiresAgentRecoveryBudget } from "../../web-ui/app/components/agents/recovery.js";

// @ts-expect-error Browser-only module.
import { chooseAgentBudget } from "../../web-ui/app/components/agents/agent-budgets.js";

function readyDraft() {
  const draft = { ...emptyAgentDraft(), role: "research", outputs: ["comparisons"], name: "Scout", modelProfileId: "local" };
  chooseAgentBudget(draft, "short", agentBudgetPresets("research", "execution-agent-v1"));
  return draft;
}
describe("Agents UI contracts", () => {
  test("onboarding requires a configured model and an explicit task allowance", () => {
    const draft = readyDraft();
    expect(validateAgentDraft({ ...draft, budget: "" }, 3, [{ id: "local" }])).toMatch(/budget/i);
    expect(validateAgentDraft(draft, 3, [])).toMatch(/model/i);
    expect(validateAgentDraft(draft, 3, [{ id: "local" }])).toBe("");
    expect(agentDraftLimits(draft)).toEqual({ maxAttempts: 3, maxModelCalls: 24, maxTotalTokens: 300_000, maxConsecutiveNoProgress: 2, maxClarificationRounds: 2 });
    const definition = formDefinition(draft);
    expect(definition).toMatchObject({ name: "Scout", icon: "pebbles-blue", modelProfileId: "local", toolPermissionMode: "ask" });
    expect(definition.basePrompt).toContain("Scout");
    expect(definition).not.toHaveProperty("executionPolicy");
  });
  test("settings keep notes and generated instructions in separate native disclosures above agent management", () => {
    const draft = { ...readyDraft(), notes: "<Keep this note>" };
    const markup = renderAgentOnboarding({ draft, step: 3, id: "scout", editing: true, models: [{ id: "local" }] });
    const sections = [...markup.matchAll(/<details><summary>(.*?)<\/summary>(.*?)<\/details>/gs)];
    expect(sections.map(section => section[1]?.split("<")[0])).toEqual(["Optional guidance", "Agent instructions"]);
    expect(sections[0]?.[2]).toContain('name="notes"');
    expect(sections[0]?.[2]).toContain("&lt;Keep this note&gt;");
    expect(sections[1]?.[2]).toContain("data-agent-prompt-preview");
    expect(markup.indexOf("agents-management-actions")).toBeGreaterThan(markup.lastIndexOf("</details>"));
  });
  test("canonical onboarding survives a reload with its model, authority, and limits", () => {
    const draft = readyDraft(), limits = agentDraftLimits(draft);
    const restored = agentDraftFromDetail({ agent: { definition: { ...formDefinition(draft), onboarding: draft } }, limits });
    expect(restored).toMatchObject({ role: "research", outputs: ["comparisons"], modelProfileId: "local", toolPermissionMode: "ask" });
    expect(agentDraftLimits(restored)).toEqual(limits);
  });
  test("API identities are encoded and bridge requests never reach a session endpoint", async () => {
    const requestApi = vi.fn(async (_path: string, _options?: RequestInit) => ({}));
    const api = createAgentRequests({ requestApi, getEnvironmentId: () => "dev / one", getConfig: () => ({ backend: "runtime" }) });
    await api.getAgent("agent/a");
    expect(requestApi.mock.calls[0]?.[0]).toBe("/agents/agent%2Fa?environment=dev%20%2F%20one");
    await api.getAgentSession("agent/a", "session/1", "other");
    expect(requestApi.mock.calls[1]?.[0]).toBe("/agents/agent%2Fa/sessions/session%2F1?environment=other");
    const bridge = createAgentRequests({ requestApi, getEnvironmentId: () => "dev", getConfig: () => ({ backend: "bridge" }) });
    expect(() => bridge.getAgent("a")).toThrow(/local Runtime/);
    await api.deleteAgent("agent/a", { expectedRevision: 13 }, "other");
    expect(requestApi.mock.calls.at(-1)).toEqual(["/agents/agent%2Fa?environment=other", { method:"DELETE", body: JSON.stringify({ expectedRevision:13 }) }]);
    expect(() => bridge.deleteAgent("a", { expectedRevision: 13 })).toThrow(/local Runtime/);
    expect(requestApi).toHaveBeenCalledTimes(3);
  });
  test("durable message receipts and onboarding drafts remain environment and agent scoped", async () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key), setItem: async (key: string, value: string) => { assertAgentDraftPreference(JSON.parse(value)); values.set(key, value); } };
    const drafts = createAgentDrafts(storage);
    await drafts.write("dev", "a", { text: "Find a monitor", pendingId: "receipt-1", intent: "task" });
    await drafts.write("dev", "$new", { onboarding: JSON.stringify(readyDraft()) });
    await drafts.write("prod", "a", { text: "Separate conversation" });
    const restored = createAgentDrafts(storage);
    expect(restored.read("dev", "a")).toMatchObject({ pendingId: "receipt-1", text: "Find a monitor" });
    expect(restored.read("prod", "a").text).toBe("Separate conversation");
    await restored.write("dev", "a", {});
    expect(restored.read("dev", "$new").onboarding).toContain("Scout");
    expect(restored.read("prod", "a").text).toBe("Separate conversation");
    expect(() => assertAgentDraftPreference({ 'unscoped': { text: "x" } })).toThrow();
    expect(() => assertAgentDraftPreference({ '["dev","a"]': { text: "x", pendingId: "", onboarding: "", intent: "task", modelCall: true } })).toThrow();
  });
  test("the space route never leaks a selected user conversation", () => {
    const address = workspaceRouteUrl({ workspace: "agents", agent: "agent/a", environment: "dev", session: "user-chat" });
    expect(address).toBe("/agents?environment=dev&agent=agent%2Fa");
    expect(readWorkspaceRoute(new URL(address, "http://localhost"))).toMatchObject({ workspace: "agents", agent: "agent/a", session: "" });
  });
  test("orbits keep ABot centered and move slowly with finite mobile positions", () => {
    expect(agentOrbitPoint(0, 13, 0, 1200, 800)).toEqual(agentOrbitPoint(0, 13, 60, 1200, 800));
    const before = agentOrbitPoint(1, 13, 0, 1200, 800), after = agentOrbitPoint(1, 13, 1, 1200, 800);
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(4);
    for (let index = 0; index < 22; index++) { const point = agentOrbitPoint(index, 22, 0, 375, 700); expect(Number.isFinite(point.x)).toBe(true); expect(point.x).toBeGreaterThan(0); expect(point.x).toBeLessThan(375); }
  });
  test("ABot is a round mint Pebbles coordinator, separate from the existing Spark feature", () => {
    expect(agentPortrait({ id: "abot" })).toContain("agents-eyes");
    expect(agentPortrait({ id: "abot" })).not.toContain("<img");
    expect(agentColor({ id: "abot" })).toBe("#91efde");
    expect(renderAgentMessages([{ id: "1", role: "abot", text: "Ready" }])).toContain(">ABot</span>");
  });
  test("only the conversation composer is offered, including on a new agent", () => {
    const composer = renderAgentConversation();
    expect(composer.match(/<textarea/g)).toHaveLength(1);
    expect(composer).not.toContain('name="intent"');
    expect(composer).not.toMatch(/Unconfirmed|data-agents-draft-state/);
    expect(renderAgentMessages([])).toBe("");
  });
  test("a saved invalid management decision shows the result and explicit recovery action", () => {
    const detail = { status: "awaiting_user_decision", mission: { id: "task", agentId: "scout", status: "awaiting_user_decision", waitingReason: "agents_plan_invalid" },
      attempts: [{ agentId: "scout", missionId: "task", status: "settled", result: { status: "completed" } }] };
    const state = renderAgentTaskState(detail);
    expect(state).toContain("The work session returned a result");
    expect(state).toContain("Task paused");
    expect(state).toContain('data-agents-action="resume">Continue task');
    expect(state).toContain('data-agents-action="cancel">End task');
    expect(renderTaskControls(detail)).toBe("");
    expect(state).not.toContain("agents_plan_invalid");
  });
  test("a legacy paused conversation exposes a usable reply path and human context", () => {
    const detail = { status: "awaiting_user_decision",
      mission: { id: "first", status: "awaiting_user_decision", waitingReason: "agents_plan_rejected_conversation_cannot_dispatch" },
      messages: [{ missionId: "first", role: "user", purpose: "conversation" }] };
    const state = renderAgentTaskState(detail);
    expect(state).toContain('data-agents-action="resume">Continue conversation');
    expect(renderTaskControls(detail)).toContain('data-agents-action="cancel">End turn');
    expect(state).not.toMatch(/agents_plan_rejected|Stop task/);
  });
  test("orbit preview adds work detail only when there is something current to show", () => {
    const current = { hasWork: true, mission: { status: "active", objective: "Check the three offers" }, latestAgentMessage: "I found the first offer." };
    expect(agentHoverWork({ ...current, workStatus: "working" })).toEqual({ label: "Working on", text: current.mission.objective });
    expect(agentHoverWork({ ...current, workStatus: "awaiting_approval" })).toEqual({ label: "Waiting for approval", text: "" });
    expect(agentHoverWork({ ...current, workStatus: "working", latestAgentMessage: current.mission.objective })).toBeNull();
    expect(agentHoverWork({ ...current, workStatus: "awaiting_user_decision" })).toBeNull();
    expect(agentHoverWork({ ...current, workStatus: "idle", mission: { ...current.mission, status: "completed" } })).toBeNull();
    expect(agentHoverWork({ workStatus: "thinking", mission: null })).toBeNull();
    expect(agentHoverWork({ ...current, workStatus: "thinking", hasWork: false })).toBeNull();
  });
  test.each(["user", "assistant", "abot"])("renders %s chat text with the shared Markdown and link policy", (role) => {
    const text = "**שלום**\n\n- אחד\n- שני\n\n[Details](https://example.org/details) [Unsafe](javascript:alert(1))";
    const body = renderAgentMessages([{ id: "msg", role, text }]);
    expect(body).toContain('<div class="markdown-body" dir="auto">');
    expect(body).toContain("<strong>שלום</strong>");
    expect(body).toContain("<li>שני</li>");
    expect(body).toContain('href="https://example.org/details"');
    expect(body).not.toContain('href="javascript:');
  });
  test("untrusted messages and approval text stay inert, and recovery uses canonical state", () => {
    expect(renderAgentMessages([{ id: "1", role: "user", text: '<img src=x onerror="x()">' }])).not.toContain("<img");
    expect(renderAgentApprovals([{ request: { description: "<script>alert(1)</script>" } }])).not.toContain("<script>");
    expect(requiresAgentRecoveryBudget({ recovery: { requiresNewBudget: true }, attempts: [] })).toBe(true);
    expect(requiresAgentRecoveryBudget({ attempts: [{ status: "unknown", userResolved: false }] })).toBe(true);
    expect(requiresAgentRecoveryBudget({ attempts: [{ status: "unknown", userResolved: true }] })).toBe(false);
  });
});

test("clarifications in the conversation use the regular composer", () => {
  const detail = { status: "awaiting_user_decision", mission: { status: "awaiting_user_decision" }, pendingUserQuestionId: "asked-in-chat" };
  const question = renderAgentTaskState(detail);
  expect(question).not.toContain('data-agents-action="resume"');
  expect(renderTaskControls(detail)).toContain('data-agents-action="cancel"');
});

test("running work keeps the composer clear and exposes controls and sessions through Manage", () => {
  const detail = { status: "working", hasWork: true, mission: { status: "active", objective: "Very long task" } };
  const chat = renderAgentConversation(), footer = chat.slice(chat.indexOf("data-agents-messages"));
  expect(footer).not.toMatch(/Work sessions|Pause and edit|data-agents-task-controls/);
  expect(chat.indexOf("data-agents-task-controls")).toBeLessThan(chat.indexOf("</header>"));
  expect(renderAgentTaskState(detail)).toBe("");
  expect(renderTaskControls(detail)).toMatch(/Pause and edit task.*Pause task.*Stop task/);
  const sessions = renderAgentSessions([{ sessionId: "one", purpose: "<First>" }, { sessionId: "two", purpose: "Second" }], [
    { request: { sessionId: "one" }, status: "settled", result: { status: "completed" } },
    { request: { sessionId: "one" }, status: "running" },
  ]);
  expect(sessions).not.toMatch(/Session [0-9]/);
  expect(sessions.indexOf("Second")).toBeLessThan(sessions.indexOf("&lt;First&gt;"));
  expect(sessions).toMatch(/&lt;First&gt;.*Working/s);
  expect(sessions).not.toContain("Completed");
});

test("a paused task exposes the specific chat block and the recovery action supported by its accounting", () => {
  const detail = { status: "awaiting_user_decision", mission: { id: "paused", status: "awaiting_user_decision", waitingReason: "agents_model_call_limit_reached" },
    recovery: { requiresNewBudget: false, pausedChatBlock: "Model calls used <15/15>" } };
  const exhausted = renderAgentTaskState(detail);
  expect(exhausted).toContain("Model calls used &lt;15/15&gt;");
  expect(exhausted).toContain('data-agents-action="cancel">End task');
  expect(exhausted).not.toMatch(/data-agents-action="resume"|agents_model_call_limit_reached/);
  const unknown = renderAgentTaskState({ ...detail, recovery: { requiresNewBudget: true } });
  expect(unknown).toContain("previous outcome or cost is unknown");
  expect(unknown).toContain('data-agents-action="resume">Review task &amp; budget');
});
