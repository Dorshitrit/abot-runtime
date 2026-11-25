import { expect, test, vi } from "vitest";
import { createAgentCoordinationPort } from "../agents/coordination-port.js";
import { createEmptyAgentState } from "../agents/agent-records.js";
import type { AgentState, AgentOnboarding } from "../agents/agent-records.js";
import { agentRolePurpose, agentOutputLabels, buildAgentBasePrompt } from "../agents/authoring-prompt.js";
import type { AgentApplicationDetail, AgentApplicationService, AgentCoordinationRequest } from "../agents/application-contracts.js";
import type { FileAgentStateStore } from "../agents/file-store.js";
import { agentDefinition } from "./support/agents-foundation-fixture.js";

const limits = { maxAttempts: 3, maxModelCalls: 12, maxTotalTokens: 20000, maxConsecutiveNoProgress: 2, maxClarificationRounds: 2 };
const timestamp = "2026-11-17T00:00:00.000Z";
function fixture() {
  const agent = { id: "research", revision: 1, status: "active" as const, definition: { ...agentDefinition(), defaultLimits: limits }, createdAt: timestamp, updatedAt: timestamp };
  const mission: AgentState["missions"][number] = { id: "child-mission", agentId: agent.id, revision: 1, status: "completed", objective: "Check sources", successCriteria: [], waitingReason: null, limits,
    usage: { attempts: 1, modelCalls: 4, totalTokens: 500, consecutiveNoProgress: 0, clarificationRounds: 0 }, createdAt: timestamp, updatedAt: timestamp };
  const assignment = {id:"peer:exchange-1",agentId:agent.id,missionId:mission.id,role:"abot" as const,purpose:"request" as const,
    source:{agentId:"abot",missionId:"parent-mission",correlationId:"exchange-1"},text:"Check these sources",createdAt:timestamp};
  let state: AgentState = { ...createEmptyAgentState(), agents: [agent], missions: [mission], messages: [assignment, { id: "reply", agentId: agent.id, missionId: mission.id, role: "assistant", purpose: "reply", source: null, text: "Verified result", createdAt: timestamp }] };
  const detail: AgentApplicationDetail = { peerClarification: null, recovery: { requiresNewBudget: false }, agent, mission: null, status: "idle", messages: [], sessions: [], attempts: [], decisions: [], responsibility: [], mailbox: [], activity: null };
  const app = { snapshot: vi.fn(async () => ({ revision: 0, agents: [detail] })), detail: vi.fn(async () => detail), receive: vi.fn(async () => ({ ...detail, mission, messages:state.messages })), refresh: vi.fn(async () => detail), cancel: vi.fn(async () => detail), answerPeerClarification: vi.fn(async () => "answered" as const) };
  const store = { read: async () => state } as FileAgentStateStore;
  const port = createAgentCoordinationPort({ store, application: () => app as unknown as AgentApplicationService });
  const abort = new AbortController();
  const request: AgentCoordinationRequest = { correlationId: "exchange-1", senderAgentId: "abot", missionId: "parent-mission", recipientAgentId: agent.id, assignment: "Check these sources", limits: { ...limits, maxAttempts: 8 }, toolPermissionMode: "ask", signal: abort.signal };
  return { app, port, request, detail, abort, get state() { return state; }, setState(value: AgentState) { state = value; } };
}

test("only ABot receives the bounded peer catalogue; private conversations are excluded", async () => {
  const f = fixture(); expect(await f.port.peers("research")).toEqual([]);
  const peers = await f.port.peers("abot"); expect(peers).toHaveLength(1);
  expect(Object.keys(peers[0]).sort()).toEqual(["id", "modelProfileId", "name", "notes", "notesOmittedCharacters", "preferredOutputs", "purpose", "purposeOmittedCharacters", "source", "status"]);
  expect(JSON.stringify(peers)).not.toContain("Verified result");
});

const catalogueOnboarding: AgentOnboarding = {
  role: "custom", custom: "Custom focus", notes: "Additional guidance", outputs: ["summaries", "comparisons"],
  style: "balanced", asks: ["unclear"], updates: "needed", color: "blue", budget: "standard",
};

async function catalogueFor(onboarding: AgentOnboarding | undefined, basePrompt = "Legacy role") {
  const f = fixture();
  const detail = { ...f.detail, agent: { ...f.detail.agent,
    definition: { ...f.detail.agent.definition, onboarding, basePrompt } }, messages: f.state.messages };
  const before = structuredClone(detail);
  f.app.snapshot.mockResolvedValue({ revision: 0, agents: [detail] });
  const peers = await f.port.peers("abot");
  expect(detail).toEqual(before);
  expect(f.app.receive).not.toHaveBeenCalled();
  expect(f.app.refresh).not.toHaveBeenCalled();
  expect(JSON.stringify(peers)).not.toContain("Verified result");
  expect(Object.keys(peers[0]!).sort()).toEqual([
    "id", "modelProfileId", "name", "notes", "notesOmittedCharacters", "preferredOutputs",
    "purpose", "purposeOmittedCharacters", "source", "status",
  ]);
  return peers[0]!;
}

test("catalogue preserves 2000-character custom focus and notes independently of generated boilerplate", async () => {
  const onboarding = { ...catalogueOnboarding, custom: "f".repeat(2000), notes: "n".repeat(2000) };
  const peer = await catalogueFor(onboarding, "PRIVATE_BASE_PROMPT");
  expect(peer).toMatchObject({ purpose: onboarding.custom, notes: onboarding.notes, source: "onboarding",
    preferredOutputs: ["Concise summaries", "Side-by-side comparisons"], purposeOmittedCharacters: 0, notesOmittedCharacters: 0 });
  expect(JSON.stringify(peer)).not.toContain("PRIVATE_BASE_PROMPT");
});

test.each(["research", "writing", "coding", "planning", "everyday"] as const)("catalogue shares %s purpose and output labels with prompt authoring", async (role) => {
  const onboarding = { ...catalogueOnboarding, role, custom: "UNUSED_CUSTOM" };
  const peer = await catalogueFor(onboarding, "PRIVATE_BASE_PROMPT");
  expect(peer.purpose).toBe(agentRolePurpose(onboarding));
  expect(peer.preferredOutputs).toEqual(agentOutputLabels(onboarding.outputs));
  expect(peer).toMatchObject({ source: "onboarding", notes: onboarding.notes, purposeOmittedCharacters: 0, notesOmittedCharacters: 0 });
  const prompt = buildAgentBasePrompt("Research", onboarding);
  expect(prompt).toContain('Your standing focus: ' + JSON.stringify(peer.purpose) + '.');
  expect(prompt).toContain('Prefer these deliverables: ' + peer.preferredOutputs!.join('; ') + '.');
  expect(JSON.stringify(peer)).not.toContain("UNUSED_CUSTOM");
  expect(JSON.stringify(peer)).not.toContain("PRIVATE_BASE_PROMPT");
});

test.each([0, 499, 500, 501, 16000])("legacy catalogue reports exact fallback omissions for %i characters", async (length) => {
  const basePrompt = "x".repeat(length);
  expect(await catalogueFor(undefined, basePrompt)).toMatchObject({
    purpose: basePrompt.slice(0, 500), source: "base_prompt_fallback", notes: "", preferredOutputs: [],
    purposeOmittedCharacters: Math.max(0, length - 500), notesOmittedCharacters: 0,
  });
});

test.each(["", "   "])("blank custom focus falls back without losing separate notes and outputs (%j)", async (custom) => {
  expect(await catalogueFor({ ...catalogueOnboarding, custom }, "x".repeat(650))).toMatchObject({
    purpose: "x".repeat(500), source: "base_prompt_fallback", notes: catalogueOnboarding.notes,
    preferredOutputs: ["Concise summaries", "Side-by-side comparisons"], purposeOmittedCharacters: 150, notesOmittedCharacters: 0,
  });
});

test("catalogue defensively bounds oversized role data and reports exact omitted characters", async () => {
  expect(await catalogueFor({ ...catalogueOnboarding, custom: "f".repeat(2017), notes: "n".repeat(2023) })).toMatchObject({
    purpose: "f".repeat(2000), notes: "n".repeat(2000), source: "onboarding", purposeOmittedCharacters: 17, notesOmittedCharacters: 23,
  });
});

test("delegation binds exact sender/correlation/assignment, clamps to both budgets and returns measured child usage", async () => {
  const f = fixture(); const reply = await f.port.coordinate(f.request);
  expect(f.app.receive).toHaveBeenCalledExactlyOnceWith("research", { messageId: "peer:exchange-1", text: "Check these sources", intent: "task", expectedAgentRevision:1, limits }, { agentId: "abot", missionId: "parent-mission", correlationId: "exchange-1" });
  expect(reply).toEqual({ outcome: "completed", text: "Research · completed\nVerified result", usage: { modelCalls: 4, totalTokens: 500, attempts: 1, clarificationRounds: 0 } });
});

test.each(["peer_busy", "permission_escalation", "limits_required"])("rejects %s before recipient admission", async (reason) => {
  const f = fixture();
  if (reason === "peer_busy") f.app.detail.mockResolvedValueOnce({ ...f.detail, status: "working" });
  if (reason === "permission_escalation") f.app.detail.mockResolvedValueOnce({ ...f.detail, agent: { ...f.detail.agent, definition: { ...f.detail.agent.definition, toolPermissionMode: "full_plus" } } });
  if (reason === "limits_required") f.app.detail.mockResolvedValueOnce({ ...f.detail, agent: { ...f.detail.agent, definition: { ...f.detail.agent.definition, defaultLimits: undefined } } });
  await expect(f.port.coordinate(f.request)).rejects.toThrow(`agents_peer_${reason === "peer_busy" ? "busy" : reason}`);
  expect(f.app.receive).not.toHaveBeenCalled();
});

test.each([{ senderAgentId: "research" }, { recipientAgentId: "abot" }])("rejects circular/non-ABot delegation %#", async (change) => {
  const f = fixture(); await expect(f.port.coordinate({ ...f.request, ...change })).rejects.toThrow("agents_peer_target_invalid"); expect(f.app.receive).not.toHaveBeenCalled();
});

test("unknown child usage remains unknown rather than creating a free peer reply", async () => {
  const f = fixture(); f.setState({ ...f.state, invocations: [{ missionId: "child-mission", status: "reserved" } as AgentState["invocations"][number]] });
  expect((await f.port.coordinate(f.request)).usage).toBeNull();
});

test("parent cancellation reaches the child ordinary controller and ends waiting", async () => {
  const f = fixture(); f.app.refresh.mockImplementationOnce(async () => { f.abort.abort(new Error("cancelled by user")); return f.detail; });
  f.setState({ ...f.state, missions: f.state.missions.map((mission) => ({ ...mission, status: "active" })) });
  await expect(f.port.coordinate(f.request)).rejects.toThrow("cancelled by user"); expect(f.app.cancel).toHaveBeenCalledExactlyOnceWith("research","child-mission");
});

test("a newer mission in the recipient view cannot become the delegated result", async () => {
  const f = fixture();
  const replacement = { ...f.state.missions[0]!, id:"independent", status:"completed" as const };
  const unrelatedReply = { ...f.state.messages[1]!, id:"independent-reply",missionId:replacement.id,text:"Private unrelated result" };
  f.setState({...f.state,missions:[...f.state.missions,replacement],messages:[...f.state.messages,unrelatedReply]});
  f.app.receive.mockResolvedValueOnce({...f.detail,mission:replacement,messages:f.state.messages});
  expect((await f.port.coordinate(f.request)).text).toBe("Research · completed\nVerified result");
  expect(f.app.refresh).toHaveBeenCalledExactlyOnceWith("research","child-mission");
});

test("abort between polls remains bound to the delegated mission after the recipient starts a new task", async () => {
  const f = fixture();
  f.setState({...f.state,missions:f.state.missions.map((mission) => ({...mission,status:"active"}))});
  const pending = expect(f.port.coordinate(f.request)).rejects.toThrow("parent stopped");
  await vi.waitFor(() => expect(f.app.refresh).toHaveBeenCalledOnce());
  const completed = {...f.state.missions[0]!,status:"completed" as const};
  const replacement = {...completed,id:"replacement",status:"active" as const};
  f.setState({...f.state,missions:[completed,replacement]});
  f.app.detail.mockResolvedValue({...f.detail,mission:replacement,status:"working"});
  f.abort.abort(new Error("parent stopped"));
  await pending;
  expect(f.app.cancel).toHaveBeenCalledExactlyOnceWith("research","child-mission");
});


test("a typed child question routes to the exact coordinator exchange before the child resumes", async () => {
  const f = fixture(); const question = { questionMessageId: "question-1", exchangeId: "exchange-1", parentAgentId: "abot", childMissionId: "child-mission" };
  f.setState({ ...f.state, missions: f.state.missions.map((mission) => ({ ...mission, status: "awaiting_user_decision" })) });
  f.app.refresh.mockResolvedValueOnce({ ...f.detail, status: "awaiting_user_decision", peerClarification: question });
  f.app.answerPeerClarification.mockImplementationOnce(async () => {
    f.setState({ ...f.state, missions: f.state.missions.map((mission) => ({ ...mission, status: "completed" })) }); return "answered";
  });
  expect((await f.port.coordinate(f.request)).outcome).toBe("completed");
  expect(f.app.answerPeerClarification).toHaveBeenCalledExactlyOnceWith({ ...question, childAgentId: "research", signal: f.abort.signal });
});

test("a mismatched question cannot obtain a coordinator reply", async () => {
  const f = fixture();
  f.app.refresh.mockResolvedValueOnce({ ...f.detail, peerClarification: { questionMessageId: "foreign", exchangeId: "wrong-exchange", parentAgentId: "abot", childMissionId: "child-mission" } });
  await f.port.coordinate(f.request); expect(f.app.answerPeerClarification).not.toHaveBeenCalled();
});
