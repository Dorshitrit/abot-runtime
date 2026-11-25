import { randomUUID } from "node:crypto";
import type { AgentApplicationDependencies } from "./application-contracts.js";
import type { AgentPeerClarificationRequest } from "./peer-clarification-records.js";
import { createAgentManagementModel } from "./management-model.js";
import { requireAgentFields, requireAgentText } from "./record-validation.js";
import { AgentStateError } from "./state-error.js";
const INSTRUCTIONS="Answer one clarification from an Agent assigned by ABot. Use only the current accepted parent request, explicit current user clarifications and the bounded assignment. No prior private conversation or standing prompt is provided. Do not invent user preferences, authority, approvals, resources or evidence. If the answer is not established, choose needs_user. Your reply only clarifies the same assignment and cannot increase permissions or change its scope. Output the requested JSON, with a concise answer in text.";
const FORMAT={type:"json_schema",name:"agent_peer_clarification",strict:true,schema:{type:"object",additionalProperties:false,required:["action","text"],properties:{action:{type:"string",enum:["answer","needs_user"]},text:{type:"string",minLength:1,maxLength:4000}}}};
export function createAgentPeerClarificationService(deps:AgentApplicationDependencies,launch:(agentId:string,missionId:string)=>void) {
  const invoke=createAgentManagementModel(deps);
  return async(request:AgentPeerClarificationRequest):Promise<"answered"|"awaiting_user_decision">=>{
    const state=await deps.store.read(),exchange=state.mailbox.find((entry)=>entry.id===request.exchangeId&&entry.agentId===request.parentAgentId&&entry.recipientAgentId===request.childAgentId);
    if(!exchange||request.parentAgentId!=="abot")throw new AgentStateError("agents_peer_exchange_missing");
    if(!state.messages.some((entry)=>entry.id===request.questionMessageId&&entry.agentId===request.childAgentId&&entry.missionId===request.childMissionId&&entry.purpose==="question"))throw new AgentStateError("agents_peer_question_invalid");
    const existing=exchange.clarifications?.find((entry)=>entry.questionMessageId===request.questionMessageId);
    if(existing)return existing.status==="answered"?"answered":"awaiting_user_decision";
    const clarificationId=randomUUID();
    try {
      const response=await invoke({agentId:request.parentAgentId,missionId:exchange.missionId,stage:"authoring",instructions:INSTRUCTIONS,format:FORMAT,signal:request.signal,
        peerClarification:{exchangeId:exchange.id,childMissionId:request.childMissionId,questionMessageId:request.questionMessageId,clarificationId}});
      const proposal=requireAgentFields(JSON.parse(response.text),["action","text"],"peerReply");
      if(proposal.action!=="answer"&&proposal.action!=="needs_user")throw new AgentStateError("agents_peer_reply_invalid");requireAgentText(proposal.text,"peerReply.text");
      if(proposal.text.length>4000)throw new AgentStateError("agents_peer_reply_invalid");
      const settled=await deps.store.commitApplication({kind:"settle_peer_clarification",agentId:request.parentAgentId,missionId:exchange.missionId,exchangeId:exchange.id,clarificationId,outcome:proposal.action,text:proposal.text});
      const child=settled.missions.find((entry)=>entry.id===request.childMissionId);
      if(child?.status==="active")launch(request.childAgentId,child.id);
      return child?.status==="active"?"answered":"awaiting_user_decision";
    } catch(error) {
      const retained=await deps.store.read();
      if(retained.mailbox.find((entry)=>entry.id===exchange.id)?.clarifications?.some((entry)=>entry.id===clarificationId))await deps.store.commitApplication({kind:"settle_peer_clarification",agentId:request.parentAgentId,missionId:exchange.missionId,exchangeId:exchange.id,clarificationId,outcome:"unknown",text:null});
      return "awaiting_user_decision";
    }
  };
}
