import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatMessage } from "../../../model-gateway/types.js";
import { vi } from "vitest";
import type { ModelGatewayClient } from "../../ports.js";
import type { AgentActionPlan } from "../../agents/workspace-records.js";
import type { AgentState } from "../../agents/agent-records.js";
import type { AgentApplicationService, AgentWorkPort, AgentWorkResult } from "../../agents/application-contracts.js";
import { FileAgentStateStore } from "../../agents/file-store.js";
import { createAgentApplication } from "../../agents/application-service.js";
import { createRuntimeConfig, disposeCompositionFixtures } from "./runtime-composition-fixture.js";
import { agentDefinition, agentMissionLimits } from "./agents-foundation-fixture.js";
const applications:AgentApplicationService[]=[];
export function trackAgentApplication(app:AgentApplicationService):AgentApplicationService {applications.push(app);return app;}
export async function disposeAgentApplicationFixtures():Promise<void> {
  await Promise.all(applications.splice(0).map((app)=>app.shutdown()));
  await disposeCompositionFixtures();
}
function abortableWork(work:Promise<AgentWorkResult>,signal:AbortSignal):Promise<AgentWorkResult> {
  return new Promise((resolve,reject)=>{
    const aborted=()=>reject(signal.reason??new Error("Fixture work aborted"));
    if(signal.aborted){aborted();return;}
    signal.addEventListener("abort",aborted,{once:true});
    void work.then(resolve,reject).finally(()=>signal.removeEventListener("abort",aborted));
  });
}
export function applicationPlan(action:AgentActionPlan["action"],extra:Partial<AgentActionPlan>={}):AgentActionPlan {
  const report = ["start_session", "continue_session", "delegate_agent"].includes(action) ? { publicUpdate: "I’ll check the requested information." } : {};
  return {action,...report,reason:"Use the recorded evidence for the accepted request.",sessionId:null,recipientAgentId:null,evidenceIds:[],metCriteriaIds:[],...extra};
}
export function returnedWorkDecision(action: "answer_user" | "continue_session" = "answer_user", reason = "Report what this work session established.") {
  if (action === "continue_session") return { action, reason, publicUpdate: "I’ll check the remaining requirement." };
  return { action, reason };
}

export const completedAgentWork:AgentWorkResult={status:"completed",output:"Verified result: https://example.test/source",error:null,receiptId:"terminal-1",usage:{modelCalls:2,totalTokens:20}};
export async function agentApplicationFixture(options:{policy?:"execution-agent-v1"|"supervisor-worker-v1";choose?:(state:AgentState)=>AgentActionPlan|ReturnType<typeof returnedWorkDecision>|string;result?:AgentWorkResult;run?:()=>Promise<AgentWorkResult>}={}) {
  const config=await createRuntimeConfig();
  config.models={providers:{local:{type:"ollama"}},profiles:{"fixture-super":{provider:"local",model:"scripted",contextWindowTokens:32768}},defaults:{profileId:"fixture-super"}};
  config.modelExecutionPolicies={"fixture-super":{policy:options.policy??"execution-agent-v1"}};
  await writeFile(config.requestRunner!.configPath!,JSON.stringify({schemaVersion:2,models:{defaults:{profileId:"fixture-super",steps:{}}},context:{outputReserveTokens:1000,safetyReserveTokens:200,attachmentReserveTokens:100},stepDefaults:{timeoutMs:5000},steps:{}}));
  const store=new FileAgentStateStore(join(config.paths.runtimeDir,"agents","state.json"));
  await store.commitApplication({kind:"register_agent",agentId:"agent-a",definition:{...agentDefinition(),executionPolicy:options.policy??"execution-agent-v1",defaultLimits:agentMissionLimits()}});
  const invoke=vi.fn<ModelGatewayClient["invoke"]>(async(input)=>{
    const state=await store.read();
    let text="A precise assignment for the existing ordinary runtime.";
    if((input.messages as ChatMessage[])[0]?.content.includes("Reply to the newest user's conversation")) text="I am checking the evidence. Your new question did not change the task.";
    else if(input.format) {
      const returned = typeof input.format === "object" && input.format.name === "persistent_agent_work_result_v1";
      const plan=options.choose?.(state)??(returned ? returnedWorkDecision() : applicationPlan("start_session"));
      text=typeof plan==="string"?plan:JSON.stringify({decision:plan});
    }
    return {text,meta:{usage:{inputTokens:6,outputTokens:4,totalTokens:10}}};
  });
  const models:ModelGatewayClient={invoke,invokeRaw:vi.fn(async()=>{throw new Error("Raw gateway must not run");})};
  const createSession=vi.fn(async()=>{}),run=vi.fn<AgentWorkPort["run"]>(async()=>options.run?options.run():options.result??completedAgentWork);
  const inspect=vi.fn(async()=>options.result??completedAgentWork),cancel=vi.fn<NonNullable<AgentWorkPort["cancel"]>>(async()=>({...completedAgentWork,status:"cancelled" as const}));
  const dependencies={store,config,models,work:{createSession,run:(request:Parameters<AgentWorkPort["run"]>[0],signal:AbortSignal)=>abortableWork(run(request,signal),signal),inspect,cancel}};
  const app=trackAgentApplication(createAgentApplication(dependencies));
  return {app,dependencies,store,invoke,createSession,run,inspect,cancel};
}
