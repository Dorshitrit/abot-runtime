import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { AgentState } from "../agents/agent-records.js";
import type { AgentApplicationService, AgentWorkResult } from "../agents/application-contracts.js";
import { createAgentApplication } from "../agents/application-service.js";
import { createAgentCoordinationPort } from "../agents/coordination-port.js";
import { FileAgentStateStore } from "../agents/file-store.js";
import { readAgentState } from "../agents/state-validation.js";
import { agentWorkspaceHash } from "../agents/workspace-validation.js";
import { agentApplicationFixture, returnedWorkDecision, applicationPlan, completedAgentWork, trackAgentApplication, disposeAgentApplicationFixtures } from "./support/agents-application-fixture.js";
afterEach(disposeAgentApplicationFixtures,20_000);
const oldId=(id:string)=>id==="abot"?"spark":id;
function legacySchema3(state:AgentState) {
  const { deletingAgentIds, ...legacyFields } = state;
  return {...legacyFields,schemaVersion:3,
    agents:state.agents.map((entry)=>({...entry,id:oldId(entry.id),definition:entry.id==="abot"?{...entry.definition,name:"Spark",icon:"spark"}:entry.definition})),
    missions:state.missions.map((entry)=>({...entry,agentId:oldId(entry.agentId)})),sessions:state.sessions.map((entry)=>({...entry,agentId:oldId(entry.agentId)})),changes:state.changes.map((entry)=>({...entry,agentId:oldId(entry.agentId)})),
    invocations:state.invocations.map((entry)=>({...entry,agentId:oldId(entry.agentId)})),decisions:state.decisions.map((entry)=>({...entry,agentId:oldId(entry.agentId)})),
    messages:state.messages.map((entry)=>({...entry,agentId:oldId(entry.agentId),role:entry.role==="abot"?"spark":entry.role,source:entry.source?{...entry.source,agentId:oldId(entry.source.agentId)}:null})),
    attempts:state.attempts.map((entry)=>{const request={...entry.request,agentId:oldId(entry.request.agentId)};return {...entry,agentId:oldId(entry.agentId),request,fingerprint:agentWorkspaceHash(request)};}),
    responsibility:state.responsibility.map((entry)=>({...entry,agentId:oldId(entry.agentId),plan:{...entry.plan,recipientAgentId:entry.plan.recipientAgentId?oldId(entry.plan.recipientAgentId):null}})),
    mailbox:state.mailbox.map((entry)=>({...entry,agentId:oldId(entry.agentId),recipientAgentId:oldId(entry.recipientAgentId)}))};
}
async function coordinator(f:Awaited<ReturnType<typeof agentApplicationFixture>>) {
  const definition=(await f.store.read()).agents[0]!.definition;
  await f.store.commitApplication({kind:"register_agent",agentId:"abot",definition:{...definition,name:"ABot",icon:"pebbles-mint"}});
  return join(f.dependencies.config.paths.runtimeDir,"agents","state.json");
}

test("schema3 identity migration preserves completed work, exact request keys and bytes until an explicit commit", {timeout:20_000}, async()=>{
  const f=await agentApplicationFixture(),filename=await coordinator(f);
  await f.app.send("abot",{messageId:"user-id",text:"Historical mention of Spark must remain unchanged",intent:"task"});await f.app.whenIdle();
  const original=await f.store.read(),legacy=legacySchema3(original),bytes=JSON.stringify(legacy);await writeFile(filename,bytes);
  const restored=new FileAgentStateStore(filename),loaded=await restored.read();
  expect(loaded.schemaVersion).toBe(6);expect(await readFile(filename,"utf8")).toBe(bytes);expect(loaded.revision).toBe(original.revision);
  expect(loaded.agents.find((entry)=>entry.id==="abot")).toMatchObject({revision:original.agents.find((entry)=>entry.id==="abot")!.revision,definition:{name:"ABot",icon:"pebbles-mint"}});
  expect(loaded.attempts).toEqual(original.attempts);expect(loaded.invocations).toEqual(original.invocations);expect(loaded.messages).toEqual(original.messages);expect(loaded.missions).toEqual(original.missions);
  await restored.commitApplication({kind:"append_agent_message",agentId:"abot",missionId:loaded.missions[0]!.id,messageId:"explicit-note",role:"user",purpose:"conversation",text:"A new explicit note"});
  expect(JSON.parse(await readFile(filename,"utf8")).schemaVersion).toBe(6);expect(f.run).toHaveBeenCalledOnce();
  const broken=legacySchema3(original);broken.attempts[0]!.fingerprint="sha256:tampered";expect(()=>readAgentState(broken)).toThrow("agents_record_invalid");
});

test("claimed work retains its identity through migration and recovery cannot redispatch it", {timeout:20_000}, async()=>{
  let release!:(value:AgentWorkResult)=>void;
  const f=await agentApplicationFixture({run:()=>new Promise((resolve)=>{release=resolve;})}),filename=await coordinator(f);
  await f.app.send("abot",{messageId:"pending",text:"Run exactly once",intent:"task"});await vi.waitFor(()=>expect(f.run).toHaveBeenCalledOnce(),{timeout:5000});
  const before=await f.store.read(),requestId=before.attempts[0]!.request.requestId;expect(before.attempts[0]?.status).toBe("claimed");
  await writeFile(filename,JSON.stringify(legacySchema3(before)));const store=new FileAgentStateStore(filename);expect((await store.read()).attempts[0]?.status).toBe("claimed");
  f.inspect.mockResolvedValue({...completedAgentWork,status:"running",usage:null});const app=trackAgentApplication(createAgentApplication({...f.dependencies,store}));await app.recover();
  const recovered=await app.detail("abot");expect(recovered.recovery.requiresNewBudget).toBe(true);expect(recovered.attempts[0]).toMatchObject({status:"unknown",request:{agentId:"abot",requestId}});expect(f.run).toHaveBeenCalledOnce();
  const unknown=await store.read();await writeFile(filename,JSON.stringify(legacySchema3(unknown)));expect((await new FileAgentStateStore(filename).read()).attempts[0]).toEqual(unknown.attempts[0]);
  release(completedAgentWork);await f.app.whenIdle();
});

test("mailbox and peer conversation migrate together without losing budgets, source correlation or outcomes", {timeout:20_000}, async()=>{
  const f=await agentApplicationFixture(),filename=await coordinator(f);let app!:AgentApplicationService;
  const coordination=createAgentCoordinationPort({store:f.store,application:()=>app});app=trackAgentApplication(createAgentApplication({...f.dependencies,...coordination}));
  f.invoke.mockImplementation(async(input)=>{
    const capsule=JSON.parse((input.messages as ChatMessage[])[1]!.content),state=await f.store.read(),mission=state.missions.find((entry)=>entry.id===capsule.mission.id)!;
    const attempts=state.attempts.filter((entry)=>entry.missionId===mission.id),exchange=state.mailbox.find((entry)=>entry.missionId===mission.id);
    const plan=mission.agentId==="abot"?(exchange?applicationPlan("complete",{evidenceIds:[exchange.id],metCriteriaIds:["request"]}):applicationPlan("delegate_agent",{recipientAgentId:"agent-a"})):(attempts.length?returnedWorkDecision():applicationPlan("start_session"));
    return {text:input.format?JSON.stringify({decision:plan}):"An explicitly bounded delegated assignment.",meta:{usage:{inputTokens:6,outputTokens:4,totalTokens:10}}};
  });
  await app.send("abot",{messageId:"delegation",text:"Delegate this check",intent:"task"});await app.whenIdle("abot");
  const original=await f.store.read();expect(original.mailbox[0]?.status).toBe("answered");expect(original.messages.some((entry)=>entry.role==="abot")).toBe(true);
  const bytes=JSON.stringify(legacySchema3(original));await writeFile(filename,bytes);const loaded=await new FileAgentStateStore(filename).read();
  expect(loaded.mailbox).toEqual(original.mailbox);expect(loaded.messages).toEqual(original.messages);expect(loaded.missions).toEqual(original.missions);expect(loaded.responsibility).toEqual(original.responsibility);expect(await readFile(filename,"utf8")).toBe(bytes);
  const collision=legacySchema3(original);collision.agents.push({...original.agents.find((entry)=>entry.id==="abot")!});expect(()=>readAgentState(collision)).toThrow("agents_record_invalid");
});

test("earliest schema3 message and mailbox shapes remain readable without inventing an outcome", {timeout:20_000}, async()=>{
  const f=await agentApplicationFixture(),filename=await coordinator(f);
  await f.app.send("abot",{messageId:"old-user",text:"A historically accepted request",intent:"task"});await f.app.whenIdle();
  const state=await f.store.read(),legacy=legacySchema3(state);
  const oldest={...legacy,messages:legacy.messages.map(({purpose:_purpose,...entry})=>entry)};
  const bytes=JSON.stringify(oldest);await writeFile(filename,bytes);const loaded=await new FileAgentStateStore(filename).read();
  expect(loaded.messages[0]?.purpose).toBe("request");expect(loaded.messages.at(-1)?.purpose).toBe("reply");expect(loaded.agents.find((entry)=>entry.id==="abot")!.definition.basePrompt).toBe(state.agents.find((entry)=>entry.id==="abot")!.definition.basePrompt);expect(await readFile(filename,"utf8")).toBe(bytes);
  const plan=applicationPlan("delegate_agent",{recipientAgentId:"agent-a"});
  const migrationOnly={...oldest,mailbox:[{id:"old-exchange",agentId:"spark",missionId:state.missions[0]!.id,missionRevision:1,traceId:"old-trace",recipientAgentId:"agent-a",assignment:"Old assignment",limits:state.missions[0]!.limits,status:"answered",output:"The prose says completed, but no typed outcome was saved.",usage:{attempts:0,modelCalls:0,totalTokens:0,clarificationRounds:0},createdAt:state.missions[0]!.createdAt,updatedAt:state.missions[0]!.updatedAt}],responsibility:[...oldest.responsibility,{...oldest.responsibility[0]!,id:"old-trace",plan,invocationId:oldest.invocations.at(-1)!.id}]};
  const {projectAgentStateSchema}=await import("../agents/state-schema.js");
  const projected=projectAgentStateSchema(migrationOnly) as AgentState;expect(projected.mailbox[0]?.outcome).toBeNull();expect(projected.mailbox[0]?.usage).toEqual(migrationOnly.mailbox[0]?.usage);
});
