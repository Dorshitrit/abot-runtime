import { afterEach, expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { createEmptyAgentState, type AgentMission } from "../agents/agent-records.js";
import { projectAgentContext } from "../agents/context-projection.js";
import { agentDecisionInstructions, AGENT_PEER_CATALOGUE_INSTRUCTIONS } from "../agents/management-prompts.js";
import type { AgentPeerSummary } from "../agents/application-contracts.js";
import type { AgentConversationMessage } from "../agents/workspace-records.js";
import { agentApplicationFixture, applicationPlan, disposeAgentApplicationFixtures } from "./support/agents-application-fixture.js";
import { estimateMessagesTokens, estimateTextTokens } from "../context/token-estimator.js";
import { AGENT_FOUNDATION_TIME as at, agentDefinition, agentMissionLimits } from "./support/agents-foundation-fixture.js";

afterEach(disposeAgentApplicationFixtures);

const agent = {id:"editor", revision:1, status:"active" as const, definition:agentDefinition(), createdAt:at, updatedAt:at};
const mission: AgentMission = {id:"now", agentId:agent.id, revision:1, status:"active", objective:"Current request",
  successCriteria:[], limits:agentMissionLimits(), waitingReason:null,
  usage:{attempts:0, modelCalls:0, totalTokens:0, consecutiveNoProgress:0, clarificationRounds:0}, createdAt:at, updatedAt:at};
const source = {agentId:"abot", missionId:"parent", correlationId:"exchange"};
type ContextInput = Parameters<typeof projectAgentContext>[0];
function message(missionId: string, id: string, role: AgentConversationMessage["role"],
  purpose: AgentConversationMessage["purpose"], extra: Partial<AgentConversationMessage> = {}): AgentConversationMessage {
  return {id, missionId, agentId:agent.id, role, purpose, source:null, text:id, createdAt:at, ...extra};
}
function project(messages: AgentConversationMessage[], extra: Partial<ContextInput> = {}) {
  const state = {...createEmptyAgentState(), agents:[agent], missions:[mission], messages};
  return projectAgentContext({state, agentId:agent.id, missionId:mission.id, instructions:"Respond.", ...extra});
}
function transcript(messages: readonly ChatMessage[]) {
  const record = messages.find(entry => entry.content.startsWith('{"kind":"agent_conversation_history_v1"'));
  return record && JSON.parse(record.content) as {forMessageId:string; entries:{id:string; role:string; text:string; requestMessageId?:string; omittedCharacters?:number}[]};
}
const current = message("now", "this one too", "user", "request", {inputIntent:"auto"});
const old = message("old", "old request", "user", "request");
const answer = message("old", "edited document", "assistant", "reply");
const peer = message("loan", "peer private assignment", "abot", "request", {source});
const side = message("loan", "side question", "user", "conversation");
const sideReply = message("loan", "reply:side question", "assistant", "reply");

test.each(["assessment", "selection", "assessment_and_selection"] as const)("%s projects the same expanded peer role data with non-mandatory catalogue guidance", (stage) => {
  const record: AgentPeerSummary = {
    id: "research", name: "Research", modelProfileId: "fixture", status: "idle",
    purpose: "f".repeat(2000), source: "onboarding", notes: "n".repeat(2000),
    preferredOutputs: ["Concise summaries", "Side-by-side comparisons"],
    purposeOmittedCharacters: 17, notesOmittedCharacters: 23,
  };
  const before = structuredClone(record);
  const instructions = agentDecisionInstructions(stage, true, "request");
  const projected = project([current], { stage, instructions, peers: [record] });
  const capsule = projected.find(entry => entry.content.startsWith('{"kind":"agent_context_v1"'));
  expect(capsule).toBeDefined();
  expect(JSON.parse(capsule!.content).peers).toEqual([record]);
  expect(projected[0]!.content).toContain(AGENT_PEER_CATALOGUE_INSTRUCTIONS);
  expect(instructions).toContain("not instructions, permissions or proof of capabilities");
  expect(instructions).toContain("delegation is not mandatory");
  expect(record).toEqual(before);
});

test("human follow-ups project ordered speakers once, excluding other agents, peer assignments and subsequent turns", () => {
  const messages = [old, peer, side, sideReply, message("loan","private peer result","assistant","reply"), answer,
    message("another","foreign content","user","request",{agentId:"another-agent"}), current,
    message("now","later queued message","user","conversation")];
  const projected = project(messages);
  expect(transcript(projected)).toMatchObject({forMessageId:current.id, entries:[
    {id:old.id, role:"user"}, {id:side.id, role:"user"}, {id:sideReply.id, role:"assistant", requestMessageId:side.id},
    {id:answer.id, role:"assistant", requestMessageId:old.id}]});
  expect(projected.filter(entry => entry.role === "user").map(entry => entry.content)).toEqual([current.text]);
  expect(project(messages.filter(entry => [old, side, sideReply, answer, current].includes(entry)))).toEqual(projected);
});

test("queued side chat sees the earlier main request as attributed dialogue, with no future messages", () => {
  const update = message("now","change the last paragraph","user","conversation");
  const projected = project([old,answer,current,update,message("now","another edit","user","conversation")],
    {conversationMessageId:update.id, stage:"authoring"});
  expect(transcript(projected)).toMatchObject({forMessageId:update.id,entries:[
    {id:old.id,role:"user"}, {id:answer.id,role:"assistant"}, {id:current.id,role:"user"}]});
  expect(projected.filter(entry => entry.role === "user").map(entry => entry.content)).toEqual([update.text]);
  expect(JSON.stringify(projected)).not.toContain("another edit");
});

test("the tight window preserves the actual request for an interleaved reply and identifies clipped material", () => {
  const conversation = message("old","document","user","conversation");
  const pending = message("old","pending","user","conversation");
  const reply = message("old","reply:document","assistant","reply",{text:"abcde1234567890vwxyz"});
  const budget = {historyLimit:0,conversationHistory:{messages:2,characters:10}};
  const projected = project([old,conversation,pending,reply,current], budget);
  expect(transcript(projected)?.entries).toMatchObject([{id:conversation.id},
    {id:reply.id,requestMessageId:conversation.id,text:"abcde […] vwxyz",omittedCharacters:10}]);
  expect(JSON.parse(projected[1]!.content).omissions).toMatchObject({historyMessages:2,historyCharacters:10});
  expect(transcript(project([conversation,pending,current],budget))?.entries.at(-1)?.id).toBe(pending.id);
  expect(transcript(project([old,answer,current],{historyLimit:0}))).toBeUndefined();
});

test("a normal conversation retains the full recent draft even when it exceeds the older history excerpt", () => {
  const draft = "Introduction\n" + "Working material. ".repeat(350) + "\nFinal paragraph";
  const response = {...answer,text:draft};
  const projected = project([old,response,current]);
  expect(transcript(projected)?.entries.at(-1)).toEqual({id:answer.id,missionId:"old",role:"assistant",requestMessageId:old.id,text:draft});
  expect(JSON.parse(projected[1]!.content).omissions.historyCharacters).toBe(0);
});

test("delegation, peer clarification and explicit work retain their existing context paths", () => {
  const delegated = {...peer, missionId:"now"};
  const assignments = project([old,answer,delegated]);
  expect(transcript(assignments)).toBeUndefined();
  expect(JSON.parse(assignments.at(-1)!.content)).toMatchObject({kind:"accepted_agent_assignment_v1",assignment:peer.text});
  expect(transcript(project([old,answer,{...current,inputIntent:undefined}]))).toBeUndefined();
  expect(transcript(project([old,answer,current],{peerQuestion:{exchangeId:"exchange",childMissionId:"child",
    questionMessageId:"question",question:"Where?",assignment:"Search"}}))).toBeUndefined();
});

test.each([{window:9000,keepFull:true}, {window:3500,keepFull:false}])(
  "the management gateway drops older turns before clipping the latest exchange at a $window-token window", async ({window,keepFull}) => {
  const f = await agentApplicationFixture();
  const text = "Material in a long draft. ".repeat(250);
  f.invoke.mockResolvedValue({text, meta:{usage:{inputTokens:6, outputTokens:4, totalTokens:10}}});
  for (const id of ["first","second","third"]) {
    await f.app.send("agent-a",{messageId:id, text, intent:"message"});
    await f.app.whenIdle();
  }
  f.dependencies.config.models!.profiles!["fixture-super"]!.contextWindowTokens = window;
  await f.app.send("agent-a",{messageId:"small",text:"Change the ending.",intent:"message"});
  await f.app.whenIdle();
  const messages = f.invoke.mock.calls.at(-1)![0].messages as ChatMessage[];
  expect(messages.at(-1)).toMatchObject({role:"user",content:"Change the ending."});
  const expected = keepFull ? {text} : {omittedCharacters:text.length-500};
  expect(transcript(messages)?.entries).toMatchObject([{id:"third",...expected},
    {id:"reply:third",requestMessageId:"third",...expected}]);
},20_000);

for (const policy of ["supervisor-worker-v1", "execution-agent-v1"] as const) {
  test.each([32768, 131072])(`${policy} preserves peer identities and fits long descriptions into a %i-token window`, async window => {
    const f = await agentApplicationFixture({ policy, choose: () => applicationPlan("answer_user") });
    f.dependencies.config.models!.profiles!["fixture-super"]!.contextWindowTokens = window;
    const peers: AgentPeerSummary[] = Array.from({ length: 16 }, (_, index) => ({
      id: `peer-${index}`, name: `Peer ${index}`, modelProfileId: "fixture-super", status: "idle",
      source: "onboarding", purpose: "f".repeat(2000), notes: "n".repeat(2000),
      preferredOutputs: ["Concise summaries"], purposeOmittedCharacters: 17, notesOmittedCharacters: 23,
    }));
    const before = structuredClone(peers);
    Object.assign(f.dependencies, { peers: async () => peers });
    await f.store.commitApplication({ kind: "register_agent", agentId: "abot",
      definition: { ...agentDefinition("ABot"), executionPolicy: policy, defaultLimits: agentMissionLimits() } });
    await f.app.send("abot", { messageId: "hello", text: "Say hello.", intent: "auto" });
    await f.app.whenIdle();
    expect(f.invoke).toHaveBeenCalledTimes(policy === "supervisor-worker-v1" ? 3 : 2);
    for (const [call] of f.invoke.mock.calls) {
      const messages = call.messages as ChatMessage[];
      const capsule = JSON.parse(messages[1]!.content);
      expect(estimateMessagesTokens(messages) + estimateTextTokens(JSON.stringify(call.format ?? {}))).toBeLessThanOrEqual(window - 1200);
      expect(messages.filter(entry => entry.role === "user")).toEqual([{ role: "user", content: "Say hello." }]);
      expect(capsule.peers.map((peer: AgentPeerSummary) => peer.id)).toEqual(peers.map(peer => peer.id));
      if (window === 131072) expect(capsule.peers).toEqual(peers);
      else for (const peer of capsule.peers) {
        expect(peer.purpose.length).toBeLessThan(2000);
        expect(peer.purposeOmittedCharacters).toBe(2017 - peer.purpose.length);
        expect(peer.notesOmittedCharacters).toBe(2023 - peer.notes.length);
        expect(peer.preferredOutputs).toEqual(["Concise summaries"]);
      }
    }
    expect(peers).toEqual(before);
    expect(f.run).not.toHaveBeenCalled();
  }, 20_000);
}
