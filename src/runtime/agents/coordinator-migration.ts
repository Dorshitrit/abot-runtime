import { agentWorkspaceHash } from "./workspace-validation.js";
import { rejectAgentRecord } from "./record-validation.js";
const LEGACY_COORDINATOR_ID="spark";
const COORDINATOR_ID="abot";
const LEGACY_PROMPT="You are Spark, the user's coordinator. Understand the user's request, consult the available Agent catalog, and delegate bounded assignments to an appropriate available Agent. Read their replies and report established results. You may also use your own work sessions. Other Agents' context stays private. Never invent progress, approval, available budget or completion.";
function record(value:unknown):Record<string,unknown> {
  if(!value||typeof value!=="object"||Array.isArray(value))rejectAgentRecord("migration.record");
  return value as Record<string,unknown>;
}
function owner(value:unknown):Record<string,unknown> {
  const entry=record(value);return {...entry,agentId:entry.agentId===LEGACY_COORDINATOR_ID?COORDINATOR_ID:entry.agentId};
}
/** Identity-only projection. Request IDs, revisions, accounting, text and uncertain outcomes remain facts. */
export function migrateAgentCoordinatorIdentity(input:Record<string,unknown>):Record<string,unknown> {
  const state=structuredClone(input);
  for(const key of ["agents","missions","sessions","changes","invocations","decisions","messages","attempts","responsibility","mailbox"])if(!Array.isArray(state[key]))rejectAgentRecord(`migration.${key}`);
  // Early schema3 builds retained the facts before introducing these projections.
  const messages=(state.messages as unknown[]).map(record);
  state.messages=messages.map((entry)=>{
    if(Object.hasOwn(entry,"purpose"))return entry;
    const mission=(state.missions as unknown[]).map(record).find((item)=>item.id===entry.missionId&&item.agentId===entry.agentId);
    const initial=messages.find((item)=>item.missionId===entry.missionId&&(item.role==="user"||item.source!==null));
    const purpose=entry.role==="assistant"?"reply":initial===entry&&entry.text===mission?.objective?"request":"conversation";
    return {...entry,purpose};
  });
  state.mailbox=(state.mailbox as unknown[]).map((value)=>{const entry=record(value);return Object.hasOwn(entry,"outcome")?entry:{...entry,outcome:null};});
  const agents=(state.agents as unknown[]).map(record),legacy=agents.find((entry)=>entry.id===LEGACY_COORDINATOR_ID);
  if(!legacy)return {...state,schemaVersion:5};
  if(agents.some((entry)=>entry.id===COORDINATOR_ID))rejectAgentRecord("migration.coordinator_identity_collision");
  state.agents=agents.map((entry)=>{
    if(entry.id!==LEGACY_COORDINATOR_ID)return entry;
    const definition=record(entry.definition);
    return {...entry,id:COORDINATOR_ID,definition:{...definition,
      name:definition.name==="Spark"?"ABot":definition.name,
      icon:definition.icon==="spark"?"pebbles-mint":definition.icon,
      basePrompt:definition.basePrompt===LEGACY_PROMPT?LEGACY_PROMPT.replace("You are Spark,","You are ABot,"):definition.basePrompt}};
  });
  for(const key of ["missions","sessions","changes","invocations","decisions"])state[key]=(state[key] as unknown[]).map(owner);
  state.messages=(state.messages as unknown[]).map((value)=>{
    const entry=owner(value);return {...entry,role:entry.role===LEGACY_COORDINATOR_ID?COORDINATOR_ID:entry.role,source:entry.source===null?null:owner(entry.source)};
  });
  state.attempts=(state.attempts as unknown[]).map((value)=>{
    const entry=owner(value),request=record(entry.request);
    // Never mask an already corrupt identity fingerprint during a migration.
    if(entry.fingerprint!==agentWorkspaceHash(request))rejectAgentRecord("migration.attempt_fingerprint");
    const migrated=owner(request);return {...entry,request:migrated,fingerprint:agentWorkspaceHash(migrated)};
  });
  state.responsibility=(state.responsibility as unknown[]).map((value)=>{
    const entry=owner(value),plan=record(entry.plan);return {...entry,plan:{...plan,recipientAgentId:plan.recipientAgentId===LEGACY_COORDINATOR_ID?COORDINATOR_ID:plan.recipientAgentId}};
  });
  state.mailbox=(state.mailbox as unknown[]).map((value)=>{
    const entry=owner(value);return {...entry,recipientAgentId:entry.recipientAgentId===LEGACY_COORDINATOR_ID?COORDINATOR_ID:entry.recipientAgentId};
  });
  return {...state,schemaVersion:5};
}
