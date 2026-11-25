import { previewAgentAuthoring } from "./support/agent-authoring-form-fixture.js";
import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module.
import { createAgentsWorkspaceController } from "../../web-ui/app/components/agents/workspace-controller.js";
// @ts-expect-error Browser-only module.
import { createAgentDrafts } from "../../web-ui/app/components/agents/drafts.js";

async function settle() { for (let index = 0; index < 45; index++) await Promise.resolve(); }
const limits = { maxAttempts: 3, maxModelCalls: 12, maxTotalTokens: 20000, maxConsecutiveNoProgress: 2, maxClarificationRounds: 2 };
function harness() {
  let environment = "dev", failStorage = false, receipt = 0;
  const events = new Map<string, (event: any) => void>(), fields = new Map<string, any>(), values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key), setItem: vi.fn(async (key: string, value: string) => { if (failStorage) throw new Error("Storage is offline"); values.set(key, value); }) };
  let selectedWindow = "", contextWindow: string | null = null;
  const windows = new Map<string, { fields: Map<string, any>; detail: any; busy: boolean; draft: any; error: string }>();
  const ensureWindow = (id: string) => {
    if (!windows.has(id)) windows.set(id, { fields: new Map(), detail: null, busy: false, draft: null, error: "" });
    return windows.get(id)!;
  };
  const windowTarget = (id: string, dataset: Record<string, string> = {}) => ({
    dataset, closest: (selector: string) => selector === '[data-agent-window]' ? { dataset: { agentWindow: id } } : null,
  });
  const query = (key: string) => {
    const id = contextWindow ?? selectedWindow;
    const local = key === 'textarea[name="message"]' || /response-status|chat-|agents-manage|session-index/.test(key);
    const owner = id || "a";
    const map = local ? ensureWindow(owner).fields : fields;
    if (!map.has(key)) map.set(key, { value: "", textContent: "", hidden: true, focus: vi.fn(),
      closest: (selector: string) => local && selector === '[data-agent-window]' ? { dataset: { agentWindow: owner } } : null });
    return map.get(key);
  };
  const inWindow = (id: string, operation: () => any) => {
    const before = contextWindow; contextWindow = id;
    try { return operation(); } finally { contextWindow = before; }
  };
  const view = { isAttentionVisible: vi.fn(() => true), root: { addEventListener: (name: string, callback: (event: any) => void) => {
    const previous = events.get(name); events.set(name, event => { previous?.(event); callback(event); });
  } }, query,
    confirmDeletion: vi.fn(async (_message: string, _options: object) => false), cancelDeletionConfirmation: vi.fn(), deletionStatus: vi.fn(),
    setActive: vi.fn(), select: vi.fn((id: string) => { selectedWindow = id; if (id) ensureWindow(id); }),
    raiseWindow: vi.fn(), closeWindow: vi.fn((id: string) => { windows.delete(id); if (selectedWindow === id) selectedWindow = ""; }),
    resetWindows: vi.fn(() => { windows.clear(); selectedWindow = ""; }),
    forWindow(id: string): any {
      return Object.fromEntries(["query", "renderDetail", "draft", "busy", "error", "recovered", "isAttentionVisible", "focusComposer"].map(name =>
        [name, (...args: any[]) => inWindow(id, () => (view as any)[name](...args))]));
    },
    renderCatalog: vi.fn(), renderDetail: vi.fn((value: any) => { ensureWindow(contextWindow ?? selectedWindow).detail = value; }),
    error: vi.fn((message: string, inChat = true) => { if (inChat && (contextWindow ?? selectedWindow)) ensureWindow(contextWindow ?? selectedWindow).error = message; }),
    busy: vi.fn((value: boolean) => { if (contextWindow ?? selectedWindow) ensureWindow(contextWindow ?? selectedWindow).busy = value; }), isBackdrop: (node: object) => node === query("space"), closeManage: vi.fn(), focusManage: vi.fn(), focusComposer: vi.fn(), focusAgent: vi.fn(), archive: vi.fn(), schedules: vi.fn(), migration: vi.fn(), recovered: vi.fn(), session: vi.fn(), hideHover: vi.fn(), hover: vi.fn(), wizard: vi.fn(),
    draft: vi.fn((value) => { ensureWindow(contextWindow ?? selectedWindow).draft = value; query('textarea[name="message"]').value = value.text; }) };
  const detail = (id = "a") => ({ agent: { id, definition: { name: "Scout", modelProfileId: "local", basePrompt: "Research", icon: "pebbles-blue", toolPermissionMode: "ask" } }, revision: 1, status: "idle", messages: [], approvals: [], attempts: [], sessions: [], limits });
  const client = { previewAgentAuthoring, supportsAgents: () => true, listModels: vi.fn(async () => ({ profiles: [{ id: "local" }] })),
    listAgents: vi.fn(async (): Promise<{revision: number; agents: any[]}> => ({ revision: 1, agents: ["a", "b", "old-agent", "new-agent"].map(id => ({ ...detail(id).agent, status: "active", sessionCount: 0 })) })),
    getAgent: vi.fn(async (_id: string, _environment?: string): Promise<any> => detail(_id)),
    readAgentReplies: vi.fn(async () => ({ ok: true })),
    sendAgentMessage: vi.fn(async (_id: string, _input: any, _environment?: string): Promise<any> => ({ ok: true })),
    deleteAgent: vi.fn(async (_id: string, _input: any, _environment?: string) => ({ ok: true })),
    updateAgent: vi.fn(async (_id: string, _input: any, _environment?: string) => detail(_id)),
    actOnAgent: vi.fn(async () => ({ ok: true })), decideAgentApproval: vi.fn(async () => ({ ok: true })) };
  const viewport = { setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(), crypto: { randomUUID: () => `receipt-${++receipt}` } };
  const controller = createAgentsWorkspaceController({ client, view, storage, getEnvironmentId: () => environment, viewport, documentRoot: { hidden: false, hasFocus: () => true, addEventListener: vi.fn() } });
  controller.bind();
  return { client, controller, detail, view, storage, viewport, events, windows, windowTarget, drafts: createAgentDrafts(storage),
    async pressEnter(target: any, options: Partial<KeyboardEvent> = {}) {
      target.closest ??= () => null;
      const preventDefault = vi.fn();
      events.get("keydown")?.({ target, key: "Enter", preventDefault, ...options });
      await settle();
      return preventDefault.mock.calls.length > 0;
    },
    async click(target: any, pressed = target) {
      events.get("pointerdown")?.({ target: pressed });
      events.get("click")?.({ target, detail: 1 });
      await settle();
    },
    submitMessageForm() { events.get("submit")?.({ preventDefault() {}, target: windowTarget(selectedWindow, { agentsForm: "message" }) }); },
    async open() { controller.setActive(true); await settle(); await controller.openRoute("a"); },
    async environment(next: string) { environment = next; await controller.environmentChanged(); },
    failStorage() { failStorage = true; },
    async type(text: string) { query('textarea[name="message"]').value = text; events.get("input")?.({ target: { closest: () => null } }); await settle(); },
    async send(text?: string) { if (text !== undefined) query('textarea[name="message"]').value = text; events.get("submit")?.({ preventDefault() {}, target: windowTarget(selectedWindow, { agentsForm: "message" }) }); await settle(); },
  };
}

describe("Agents browser lifecycle", () => {
  test("send feedback is immediate, stays bound to the receipt, and a late poll cannot relight it after a quick reply", async () => {
    const h = harness();
    await h.open(); await h.type("Hello");
    const status = h.view.query("[data-agents-response-status]");
    let accept!: (value: any) => void, finishPoll!: (value: any) => void;
    h.client.sendAgentMessage.mockImplementationOnce(() => new Promise((resolve) => { accept = resolve; }));
    h.client.getAgent.mockImplementationOnce(() => new Promise((resolve) => { finishPoll = resolve; }));
    const oldPoll = h.controller.refresh(); await settle();
    h.submitMessageForm();
    expect(status.textContent).toBe("Sending…");
    await settle();
    const request = { id: "receipt-1", missionId: "m", agentId: "a", source: null, role: "user", purpose: "request" };
    const done = { ...h.detail(), mission: { id: "m", status: "completed" }, messages: [request, { ...request, id: "answer", role: "assistant" }] };
    accept(done); await settle();
    expect(status.textContent).toBe("");
    expect(h.view.renderDetail.mock.calls.at(-1)?.[0]).toBe(done);
    finishPoll({ ...h.detail(), mission: { id: "m", status: "active" }, status: "thinking", messages: [request] }); await oldPoll;
    expect(status.textContent).toBe("");
    expect(h.view.renderDetail.mock.calls.at(-1)?.[0]).toBe(done);
  });

  test("a missing correction reply is displayed as system feedback", async () => {
    const h = harness();
    const detail = {...h.detail(), mission:{id:"work",status:"active"}, status:"working", recovery:{unansweredUpdateId:"update"}};
    h.client.getAgent.mockResolvedValue(detail);
    await h.open();
    expect(h.view.query("[data-agents-response-status]").textContent).toBe("No reply to your last update is available.");
  });

  test("polls distinguish a live reply on a paused task from a saved message after interruption", async () => {
    const h = harness();
    const chat = { id: "chat-1", agentId: "a", missionId: "paused", role: "user", purpose: "conversation", source: null };
    const waiting = { ...h.detail(), mission: { id: "paused", status: "awaiting_user_decision" },
      status: "awaiting_user_decision", messages: [{ ...chat, id: "task", purpose: "request" }, chat] };
    h.client.getAgent.mockResolvedValue(waiting); await h.open();
    const status = h.view.query("[data-agents-response-status]");
    expect(status.textContent).toBe("");
    h.client.getAgent.mockResolvedValue({ ...waiting, replyingToMessageIds: ["chat-1"] }); await h.controller.refresh();
    expect(status.textContent).toBe("Preparing a reply…");
    h.client.getAgent.mockResolvedValue({ ...waiting, replyingToMessageIds: ["chat-1"], messages: [...waiting.messages, { ...chat, id: "reply:chat-1", role: "assistant" }] });
    await h.controller.refresh(); expect(status.textContent).toBe("");
    h.client.getAgent.mockResolvedValue({ ...waiting, replyingToMessageIds: ["other-message"] });
    await h.controller.refresh(); expect(status.textContent).toBe("");
    h.client.getAgent.mockResolvedValue({ ...waiting, replyingToMessageIds: ["chat-1"], mission: { id: "paused", status: "cancelled" } });
    await h.controller.refresh(); expect(status.textContent).toBe("");
  });

  test("the open chat shows only live activity from the selected agent", async () => {
    const h = harness();
    const message = { id: "receipt", agentId: "a", missionId: "task", role: "user", purpose: "request", source: null };
    const thinking = { ...h.detail(), mission: { id: "task", status: "active" }, status: "thinking", messages: [message] };
    h.client.getAgent.mockResolvedValue(thinking); await h.open();
    const status = h.view.query("[data-agents-response-status]");
    expect(status.textContent).toBe("Thinking…");
    h.client.getAgent.mockResolvedValue({ ...thinking, hasWork: true, status: "working" }); await h.controller.refresh();
    expect(status.textContent).toBe("Working on your task…");
    h.client.getAgent.mockResolvedValue({ ...thinking, hasWork: true, status: "awaiting_approval" }); await h.controller.refresh();
    expect(status.textContent).toBe("");
    h.client.getAgent.mockResolvedValue({ ...thinking, agent: h.detail("b").agent }); await h.controller.openRoute("b");
    expect(status.textContent).toBe("");
    h.client.sendAgentMessage.mockRejectedValueOnce(new Error("Network disconnected")); await h.send("Hello");
    expect(status.textContent).toBe("");
    expect(h.drafts.read("dev", "b").pendingId).toBe("receipt-1");
  });

  test("Enter sends the current draft through its form while newline and IME confirmation remain editable", async () => {
    const h = harness();
    await h.open();
    const composer = h.view.query('textarea[name="message"]');
    const submit = vi.fn(() => h.submitMessageForm());
    composer.form = { requestSubmit: submit };
    await h.type("מה מצאת?");
    expect(await h.pressEnter(composer, { shiftKey: true })).toBe(false);
    expect(await h.pressEnter(composer, { isComposing: true })).toBe(false);
    expect(await h.pressEnter(composer, { keyCode: 229 })).toBe(false);
    expect(await h.pressEnter({ name: "notes" })).toBe(false);
    expect(await h.pressEnter(composer, { repeat: true })).toBe(true);
    expect(submit).not.toHaveBeenCalled();
    expect(await h.pressEnter(composer)).toBe(true);
    expect(submit).toHaveBeenCalledOnce();
    expect(h.client.sendAgentMessage).toHaveBeenCalledExactlyOnceWith("a", {
      text: "מה מצאת?", intent: "auto", clientMessageId: "receipt-1", limits,
    }, "dev");
  });

  test("persists intent before dispatch and retains the same receipt across an uncertain submission", async () => {
    const h = harness(); await h.open();
    h.client.sendAgentMessage.mockRejectedValueOnce(new Error("Connection closed"));
    await h.send("Find a monitor");
    expect(h.drafts.read("dev", "a")).toMatchObject({ text: "Find a monitor", pendingId: "receipt-1", intent: "auto" });
    expect(h.storage.setItem.mock.invocationCallOrder.at(-1)).toBeLessThan(h.client.sendAgentMessage.mock.invocationCallOrder[0]!);
    await h.send();
    expect(h.client.sendAgentMessage.mock.calls.map((call) => call[1].clientMessageId)).toEqual(["receipt-1", "receipt-1"]);
    expect(h.drafts.read("dev", "a").text).toBe("");
  });
  test("a draft persistence failure prevents a model dispatch", async () => {
    const h = harness(); await h.open(); h.failStorage(); await h.send("Do work");
    expect(h.client.sendAgentMessage).not.toHaveBeenCalled();
    expect(h.view.error).toHaveBeenCalledWith(expect.stringContaining("Storage is offline"));
  });
  test("an accepted server message reconciles a previously unconfirmed receipt", async () => {
    const h = harness(); await h.open();
    await h.drafts.write("dev", "a", { text: "Saved", pendingId: "known", intent: "message" });
    h.client.getAgent.mockResolvedValue({ ...h.detail(), messages: [{ id: "known", role: "user", text: "Saved" }] });
    await h.controller.refresh();
    expect(h.drafts.read("dev", "a").pendingId).toBe("");
  });
  test("a stale agent response cannot replace another environment's context", async () => {
    const h = harness(); await h.open();
    let resolveOld: (value: any) => void = () => {};
    h.client.getAgent.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const old = h.controller.openRoute("old-agent"); await settle();
    await h.environment("prod"); await h.controller.openRoute("new-agent");
    resolveOld(h.detail("old-agent")); await old;
    expect(h.view.renderDetail.mock.calls.at(-1)?.[0].agent.id).toBe("new-agent");
    expect(h.controller.selectedId()).toBe("new-agent");
  });
  test("a message sent during work follows the same automatic intake path", async () => {
    const h = harness(); await h.open();
    h.client.getAgent.mockResolvedValue({ ...h.detail(), status: "working" }); await h.controller.refresh();
    await h.send("What did you find?");
    expect(h.client.sendAgentMessage).toHaveBeenCalledExactlyOnceWith("a", {
      text: "What did you find?", clientMessageId: "receipt-1", intent: "auto", limits,
    }, "dev");
  });
  test.each(["task", "message"])("unconfirmed legacy %s submission reuses its exact tuple", async (intent) => {
    const h = harness();
    await h.drafts.write("dev", "a", { text: "  Original text  ", pendingId: "old-receipt", intent });
    await h.open();
    await h.send();
    expect(h.client.sendAgentMessage).toHaveBeenCalledExactlyOnceWith("a", {
      text: "  Original text  ", clientMessageId: "old-receipt", intent, limits,
    }, "dev");
  });
  test.each([false, true])("preserves the explicit intent only while a restored unsent draft is untouched (edited: %s)", async (edited) => {
    const h = harness();
    await h.drafts.write("dev", "a", { text: "Draft", intent: "task" });
    await h.open();
    if (edited) await h.type("Edited");
    await h.send();
    expect(h.client.sendAgentMessage).toHaveBeenCalledExactlyOnceWith("a", {
      text: edited ? "Edited" : "Draft", clientMessageId: "receipt-1", intent: edited ? "auto" : "task", limits,
    }, "dev");
  });
  test("a delayed receipt cannot erase the next draft after polling confirms acceptance", async () => {
    const h = harness(); await h.open();
    let accept: (value: any) => void = () => {};
    h.client.sendAgentMessage.mockImplementationOnce(() => new Promise((resolve) => { accept = resolve; }));
    await h.send("First message");
    h.client.getAgent.mockResolvedValue({ ...h.detail(), messages: [{ id: "receipt-1", role: "user", text: "First message" }] });
    await h.controller.refresh(); await h.type("Next draft");
    accept({ ok: true }); await settle();
    expect(h.drafts.read("dev", "a").text).toBe("Next draft");
  });
  test("an in-flight send to one agent does not block another agent", async () => {
    const h = harness(); await h.open();
    let accept: (value: any) => void = () => {};
    h.client.sendAgentMessage.mockImplementationOnce(() => new Promise((resolve) => { accept = resolve; }));
    await h.send("First agent"); await h.controller.openRoute("b"); await h.send("Second agent");
    expect(h.client.sendAgentMessage.mock.calls.map((call) => call[0])).toEqual(["a", "b"]);
    expect(h.drafts.read("dev", "a").pendingId).toBe("receipt-1");
    accept({ ok: true }); await settle();
  });
  test("inactive space does not poll or invoke model work", async () => {
    const h = harness(); await h.open(); h.controller.setActive(false);
    h.client.listAgents.mockClear(); await h.controller.refresh();
    expect(h.client.listAgents).not.toHaveBeenCalled(); expect(h.client.sendAgentMessage).not.toHaveBeenCalled();
    expect(h.viewport.clearTimeout).toHaveBeenCalled();
  });
});

test("backdrop click closes only the selected conversation and keeps its draft", async () => {
  const h = harness(); await h.open(); await h.type("טיוטה");
  const field = h.view.query("space"), chat = h.view.query("bubble");
  field.closest = chat.closest = () => null;
  await h.click(chat);
  await h.click(field, chat);
  expect(h.controller.selectedId()).toBe("a");
  await h.click(field);
  expect(h.controller.selectedId()).toBe("");
  expect(h.view.focusAgent).toHaveBeenCalledWith("a");
  expect(h.client.actOnAgent).not.toHaveBeenCalled();
  await h.controller.openRoute("a");
  expect(h.view.query('textarea[name="message"]').value).toBe("טיוטה");
});

function actionButton(dataset: Record<string, string>) {
  const button: { dataset: typeof dataset; closest: (selector: string) => unknown } = { dataset, closest: selector => selector === "button" ? button : null };
  return button;
}

test.each([true, false])("approval decision %s retains the selected approval identity and wait tuple", async approved => {
  const h = harness();
  const wait = { generation: 2, waitId: "wait-2", revision: 9 };
  h.client.getAgent.mockResolvedValue({ ...h.detail(), approvals: [
    { request: { approvalId: "approval-1", meta: { command: "first" } } },
    { request: { approvalId: "approval-2", meta: { command: "second" } }, wait },
  ] });
  await h.open();
  await h.click(actionButton({ agentApproval: "1", approved: String(approved) }));
  expect(h.client.decideAgentApproval).toHaveBeenCalledExactlyOnceWith("a", {
    approvalId: "approval-2", approved, ...wait, commandId: "receipt-1",
  }, "dev");
});

test("configuration dismisses on a backdrop click or X, restores composer focus, and retains the draft", async () => {
  const h = harness();
  await h.open();
  const configure = actionButton({ agentsAction: "configure" });
  const field = h.view.query("space");
  field.closest = () => null;
  const inner = h.view.query("inside");
  inner.closest = () => null;
  await h.click(configure);
  expect(h.view.wizard).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a" }));
  const input = { name: "name", value: "Draft Agent", closest: (selector: string) => selector.includes("onboarding") ? { dataset: { agentsForm: "onboarding" } } : null };
  h.events.get("input")!({ target: input }); await settle();
  await h.click(field, inner);
  expect(h.view.wizard.mock.lastCall?.[0]).not.toBeNull();
  h.events.get("pointerdown")!({ target: field, clientX: 30, clientY: 50 });
  h.events.get("pointermove")!({ target: field, clientX: 42, clientY: 50 });
  h.events.get("click")!({ target: field, detail: 1 });
  await settle();
  expect(h.view.wizard.mock.lastCall?.[0]).not.toBeNull();
  await h.click(field);
  expect(h.view.wizard).toHaveBeenLastCalledWith(null);
  expect(h.controller.selectedId()).toBe("a");
  expect(h.view.focusComposer).toHaveBeenCalled();
  await h.click(configure);
  expect(h.view.wizard.mock.lastCall?.[0].draft.name).toBe("Draft Agent");
  await h.click(actionButton({ agentsAction: "close-wizard" }));
  expect(h.view.wizard).toHaveBeenLastCalledWith(null);
  expect(h.client.updateAgent).not.toHaveBeenCalled();
});

test("a busy settings save stays open on a backdrop click and explains the open task", async () => {
  const h = harness(); await h.open();
  await h.click(actionButton({ agentsAction: "configure" }));
  let reject!: (reason: Error) => void;
  h.client.updateAgent.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  h.events.get("submit")!({ preventDefault() {}, target: { dataset: { agentsForm: "onboarding" }, closest: () => null } });
  await settle();
  expect(h.client.updateAgent).toHaveBeenCalledOnce();
  const field = h.view.query("space"); field.closest = () => null;
  await h.click(field);
  expect(h.view.wizard.mock.lastCall?.[0].busy).toBe(true);
  reject(new Error("agents_agent_busy")); await settle();
  expect(h.view.wizard.mock.lastCall?.[0].error).toMatch(/finish or stop.+task/i);
});

test("permanent deletion uses the observed revision and clears the selected agent and only its drafts", async () => {
  const h = harness(); await h.open();
  await h.type("Private message");
  await h.drafts.write("dev", "a:onboarding", { onboarding: "{}", text: "" });
  await h.drafts.write("dev", "a:resume", { text: "Private recovery" });
  await h.drafts.write("dev", "ab", { text: "Keep other agent" });
  await h.drafts.write("prod", "a", { text: "Keep other environment" });
  await h.click(actionButton({ agentsAction: "configure" }));
  const priorDetailReads = h.client.getAgent.mock.calls.length;
  h.client.listAgents.mockResolvedValue({ agents: [{ ...h.detail().agent, sessionCount: 2 }], revision: 7 });
  const button = actionButton({ agentDelete: "a" });
  await h.click(button);
  expect(h.view.confirmDeletion).toHaveBeenLastCalledWith(expect.stringContaining("Scout, its private conversation, schedules, and 2 work sessions"), expect.objectContaining({ tone: "danger" }));
  expect(h.client.deleteAgent).not.toHaveBeenCalled();
  expect(h.client.getAgent).toHaveBeenCalledTimes(priorDetailReads);
  expect(h.drafts.read("dev", "a").text).toBe("Private message");
  const oldCatalog = h.client.listAgents.mock.calls.length;
  h.view.confirmDeletion.mockResolvedValue(true);
  await h.click(button);
  expect(h.client.deleteAgent).toHaveBeenCalledExactlyOnceWith("a", { expectedRevision: 7 }, "dev");
  expect(h.drafts.read("dev", "a").text).toBe("");
  expect(h.drafts.read("dev", "a:resume").text).toBe("");
  expect(h.drafts.read("dev", "a:onboarding").onboarding).toBeUndefined();
  expect(h.drafts.read("dev", "ab").text).toBe("Keep other agent");
  expect(h.drafts.read("prod", "a").text).toBe("Keep other environment");
  expect(h.view.wizard).toHaveBeenLastCalledWith(null);
  expect(h.controller.selectedId()).toBe("");
  expect(h.client.listAgents.mock.calls.length).toBeGreaterThan(oldCatalog);
});

test("the archived deletion flow can retry incomplete cleanup and protects ABot and open tasks", async () => {
  const h = harness(); await h.open();
  await h.click(actionButton({ agentsAction: "archived" }));
  h.view.confirmDeletion.mockResolvedValue(true);
  const button = actionButton({ agentDelete: "archived" });
  const archived = { ...h.detail("archived").agent, status: "archived", isDeleting: true, sessionCount: 1 };
  h.client.listAgents.mockResolvedValue({ revision: 10, agents: [{ ...archived, mission: { status: "awaiting_user_decision" } }] });
  await h.click(button);
  expect(h.view.deletionStatus).toHaveBeenLastCalledWith(expect.stringContaining("open task"));
  expect(h.view.confirmDeletion).not.toHaveBeenCalled();
  h.client.listAgents.mockResolvedValue({ revision: 10, agents: [h.detail().agent, archived] });
  h.client.deleteAgent.mockRejectedValueOnce(new Error("agents_deletion_cleanup_failed"));
  await h.click(button);
  expect(h.view.deletionStatus).toHaveBeenLastCalledWith(expect.stringContaining("Retry deletion"));
  expect(h.view.confirmDeletion).toHaveBeenLastCalledWith(expect.stringContaining("1 work session?"), expect.objectContaining({confirmLabel:"Retry deletion"}));
  await h.click(button);
  expect(h.client.deleteAgent).toHaveBeenCalledTimes(2);
  expect(h.controller.selectedId()).toBe("a");
  await h.click(actionButton({ agentDelete: "abot" }));
  expect(h.client.deleteAgent).toHaveBeenCalledTimes(2);
});

test("a delayed confirmation never submits a delete to a newly selected environment", async () => {
  const h = harness(); await h.open();
  let confirm!: (value: boolean) => void;
  h.view.confirmDeletion.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
  await h.click(actionButton({ agentDelete: "a" }));
  await h.environment("prod");
  confirm(true); await settle();
  expect(h.client.deleteAgent).not.toHaveBeenCalled();
});

test("a reply is acknowledged once only while its source is visible in the selected chat", async () => {
  const h = harness(); await h.open();
  h.client.getAgent.mockResolvedValue({ ...h.detail(), latestVisibleReplyId: "own-reply" });
  h.view.isAttentionVisible.mockReturnValue(false);
  await h.controller.refresh(); expect(h.client.readAgentReplies).not.toHaveBeenCalled();
  h.view.isAttentionVisible.mockReturnValue(true);
  await h.controller.refresh(); await h.controller.refresh();
  expect(h.client.readAgentReplies).toHaveBeenCalledExactlyOnceWith("a", "own-reply", "dev");
});

test("paused chat keeps a blocked draft through Enter and submit, then sends it once when chat becomes available", async () => {
  const h = harness();
  const paused = { ...h.detail(), status: "awaiting_user_decision", mission: { id: "task", status: "awaiting_user_decision" } };
  h.client.getAgent.mockResolvedValue({ ...paused, recovery: { requiresNewBudget: true, pausedChatBlock: "Review the unknown outcome first." } });
  await h.open();
  await h.type("מה מצאת עד עכשיו?");
  const composer = h.view.query('textarea[name="message"]');
  composer.form = { requestSubmit: () => h.submitMessageForm() };
  await h.pressEnter(composer); await h.send();
  expect(h.client.sendAgentMessage).not.toHaveBeenCalled();
  expect(h.drafts.read("dev", "a")).toMatchObject({ text: "מה מצאת עד עכשיו?", pendingId: "" });
  h.client.getAgent.mockResolvedValue({ ...paused, recovery: { requiresNewBudget: false, pausedChatBlock: null } });
  await h.controller.refresh(); await h.pressEnter(composer);
  expect(h.client.sendAgentMessage).toHaveBeenCalledExactlyOnceWith("a", {
    clientMessageId: "receipt-1", intent: "auto", limits, text: "מה מצאת עד עכשיו?",
  }, "dev");
  expect(h.client.actOnAgent).not.toHaveBeenCalled();
});


describe("Agent multi-window controller regression", () => {
  test.each(["", "recovered-receipt"])("restored drafts reach the existing composer and send unchanged (receipt: %s)", async pendingId => {
    const h = harness(); await h.open(); await h.type("Current");
    await h.controller.openRoute("b"); await h.type("Other window");
    await h.controller.openRoute("a");
    const recovered = { text: "Recovered", pendingId, intent: "message" };
    await h.drafts.write("dev", "$legacy-coordinator-backup:a:restore", recovered);
    await h.click(actionButton({ agentsAction: "recovered-drafts" }));
    const restore = actionButton({ migrationRestore: "0" }), closest = restore.closest;
    restore.closest = selector => selector === "[data-agents-migration]" ? {} : closest(selector);
    await h.click(restore);
    expect(h.view.forWindow("a").query('textarea[name="message"]').value).toBe("Recovered");
    expect(h.windows.get("a")?.draft).toMatchObject(recovered);
    expect(h.drafts.read("dev", "a")).toMatchObject(recovered);
    expect(h.view.forWindow("b").query('textarea[name="message"]').value).toBe("Other window");
    expect(h.client.sendAgentMessage).not.toHaveBeenCalled();
    await h.send();
    expect(h.client.sendAgentMessage).toHaveBeenCalledExactlyOnceWith("a", {
      text: "Recovered", intent: "message", clientMessageId: pendingId || "receipt-1", limits,
    }, "dev");
  });
  test("ordinary window activation does not reload the stored draft over the composer", async () => {
    const h = harness(); await h.open(); await h.type("Saved");
    h.view.forWindow("a").query('textarea[name="message"]').value = "Still typing";
    await h.controller.openRoute("b"); await h.controller.openRoute("a");
    expect(h.view.forWindow("a").query('textarea[name="message"]').value).toBe("Still typing");
    expect(h.drafts.read("dev", "a").text).toBe("Saved");
  });
  test("keyboard focus and approval clicks select their originating window", async () => {
    const h = harness();
    h.client.getAgent.mockImplementation(async id => ({ ...h.detail(id), approvals: [{ approvalId: `approval-${id}` }] }));
    await h.open(); await h.controller.openRoute("b");
    h.events.get("focusin")!({ target: h.windowTarget("a") });
    expect(h.controller.selectedId()).toBe("a");
    await h.controller.openRoute("b");
    const button = actionButton({ agentApproval: "0", approved: "true" });
    const closest = button.closest;
    button.closest = selector => h.windowTarget("a").closest(selector) || closest(selector);
    await h.click(button);
    expect(h.client.decideAgentApproval).toHaveBeenCalledExactlyOnceWith("a", { approvalId: "approval-a", approved: true }, "dev");
  });
  test("a failed archive restore reports outside the active conversation", async () => {
    const h = harness(); await h.open();
    h.client.actOnAgent.mockRejectedValueOnce(new Error("Restore failed"));
    await h.click(actionButton({ agentRestore: "archived-agent" }));
    expect(h.client.actOnAgent).toHaveBeenCalledWith("archived-agent", expect.objectContaining({ action: "restore" }), "dev");
    expect(h.view.error).toHaveBeenCalledWith("Restore failed", false);
    expect(h.windows.get("a")?.error).not.toBe("Restore failed");
  });
  test("two windows retain independent drafts and response status", async () => {
    const h = harness(); await h.open(); await h.type("Draft A");
    await h.controller.openRoute("b"); await h.type("Draft B");
    h.client.getAgent.mockImplementation(async id => id === "a" ? {
      ...h.detail(id), status: "thinking", mission: { id: "task-a", status: "active" },
      messages: [{ id: "request-a", agentId: "a", missionId: "task-a", role: "user", purpose: "request", source: null }],
    } : h.detail(id));
    await h.controller.refresh();
    expect([...h.windows.keys()].sort()).toEqual(["a", "b"]);
    expect(h.view.forWindow("a").query('textarea[name="message"]').value).toBe("Draft A");
    expect(h.view.forWindow("b").query('textarea[name="message"]').value).toBe("Draft B");
    expect(h.view.forWindow("a").query('[data-agents-response-status]').textContent).toBe("Thinking…");
    expect(h.view.forWindow("b").query('[data-agents-response-status]').textContent).toBe("");
    expect(h.windows.get("a")?.detail.agent.id).toBe("a");
    expect(h.windows.get("b")?.detail.agent.id).toBe("b");
  });
  test("simultaneous sends stay bound to their originating windows", async () => {
    const h = harness(); await h.open(); await h.type("A message");
    await h.controller.openRoute("b"); await h.type("B message");
    const accepts = new Map<string, (value: any) => void>();
    h.client.sendAgentMessage.mockImplementation(id => new Promise(resolve => accepts.set(id, resolve)));
    const submit = (id: string) => h.events.get("submit")!({ preventDefault() {}, target: h.windowTarget(id, { agentsForm: "message" }) });
    submit("a"); submit("b"); await settle();
    expect(h.client.sendAgentMessage.mock.calls.map(([id, input, env]) => [id, input.text, env])).toEqual([
      ["a", "A message", "dev"], ["b", "B message", "dev"],
    ]);
    expect(new Set(h.client.sendAgentMessage.mock.calls.map(call => call[1].clientMessageId)).size).toBe(2);
    expect(h.windows.get("a")?.busy).toBe(true); expect(h.windows.get("b")?.busy).toBe(true);
    accepts.get("b")!({ ok: true }); await settle();
    expect(h.windows.get("a")?.busy).toBe(true); expect(h.windows.get("b")?.busy).toBe(false);
    expect(h.drafts.read("dev", "a").text).toBe("A message");
    accepts.get("a")!({ ok: true }); await settle();
    expect(h.windows.get("a")?.busy).toBe(false);
    expect(h.drafts.read("dev", "a").text).toBe(""); expect(h.drafts.read("dev", "b").text).toBe("");
  });
  test("closing and reopening rejects the previous window detail response", async () => {
    const h = harness(); await h.open();
    let finish!: (value: any) => void;
    h.client.getAgent.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const oldPoll = h.controller.refresh(); await settle();
    await h.click(actionButton({ agentsAction: "close-chat" }));
    expect(h.windows.has("a")).toBe(false);
    const fresh = { ...h.detail(), revision: 22 };
    h.client.getAgent.mockResolvedValue(fresh);
    await h.controller.openRoute("a");
    finish({ ...h.detail(), revision: 1 }); await oldPoll;
    expect(h.windows.get("a")?.detail).toBe(fresh);
    expect(h.view.closeWindow).toHaveBeenCalledWith("a");
  });
  test("environment reset clears every open window and rejects old detail", async () => {
    const h = harness(); await h.open(); await h.controller.openRoute("b");
    let finish!: (value: any) => void;
    h.client.getAgent.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = h.controller.refresh(); await settle();
    await h.environment("prod");
    expect(h.windows.size).toBe(0); expect(h.controller.selectedId()).toBe("");
    h.view.renderDetail.mockClear();
    finish(h.detail("a")); await pending;
    expect(h.view.renderDetail).not.toHaveBeenCalled();
    expect(h.view.resetWindows).toHaveBeenCalledTimes(2);
  });
  test("refresh updates all open windows without changing the focused one", async () => {
    const h = harness(); await h.open(); await h.controller.openRoute("b");
    h.client.getAgent.mockClear();
    h.client.getAgent.mockImplementation(async id => ({ ...h.detail(id), revision: 9 }));
    await h.controller.refresh();
    expect(h.client.getAgent.mock.calls.map(call => call[0]).sort()).toEqual(["a", "b"]);
    expect(h.windows.get("a")?.detail.revision).toBe(9);
    expect(h.windows.get("b")?.detail.revision).toBe(9);
    expect(h.controller.selectedId()).toBe("b");
  });
});


describe("Agent window asynchronous lifecycle regressions", () => {
  test("pending detail updates active controller state after focus leaves and returns", async () => {
    const h = harness(); await h.open();
    let finish!: (value: any) => void;
    h.client.getAgent.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = h.controller.refresh(); await settle();
    await h.controller.openRoute("b");
    await h.controller.openRoute("a");
    const updatedLimits = { ...limits, maxAttempts: 7 };
    const updated = { ...h.detail(), revision: 30, limits: updatedLimits };
    finish(updated); await pending;
    expect(h.controller.selectedId()).toBe("a");
    expect(h.windows.get("a")?.detail).toBe(updated);
    await h.send("Use the current active detail");
    expect(h.client.sendAgentMessage.mock.calls.at(-1)?.[1].limits).toEqual(updatedLimits);
  });

  test.each([false, true])("reopened window releases pending send without stale detail or draft loss (reject: %s)", async rejectSend => {
    const h = harness(); await h.open();
    let accept!: (value: any) => void, reject!: (error: Error) => void;
    h.client.sendAgentMessage.mockImplementationOnce(() => new Promise((resolve, fail) => { accept = resolve; reject = fail; }));
    await h.send("Original message");
    await h.click(actionButton({ agentsAction: "close-chat" }));
    const fresh = { ...h.detail(), revision: 50, messages: [{ id: "receipt-1", role: "user", text: "Original message" }] };
    h.client.getAgent.mockResolvedValue(fresh);
    await h.controller.openRoute("a");
    expect(h.windows.get("a")?.busy).toBe(true);
    await h.type("Newer draft");
    if (rejectSend) reject(new Error("Late transport failure"));
    else accept({ ...h.detail(), revision: 2 });
    await settle();
    expect(h.windows.get("a")?.busy).toBe(false);
    expect(h.windows.get("a")?.detail).toBe(fresh);
    expect(h.view.forWindow("a").query('[data-agents-response-status]').textContent).not.toBe("Sending…");
    expect(h.drafts.read("dev", "a").text).toBe("Newer draft");
    expect(h.view.forWindow("a").query('textarea[name="message"]').value).toBe("Newer draft");
  });
});
