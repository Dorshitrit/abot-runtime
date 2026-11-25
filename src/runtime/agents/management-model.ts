import { progressContext, sameProgressCheckpoint, type ProgressObservation } from "./progress-report.js";
import { conversationInvocationId } from "./conversation-intent.js";
import { randomUUID } from "node:crypto";
import { normalizeModelTokenUsage } from "../../model-gateway/protocol/usage.js";
import { resolveModelInvocation } from "../../model-gateway/invocation-policy.js";
import { estimateMessagesTokens, estimateTextTokens } from "../context/token-estimator.js";
import { loadRequestRunnerConfig } from "../config/runner/loader.js";
import type { AgentApplicationDependencies, AgentPeerSummary } from "./application-contracts.js";
import { captureAgentDecisionConfiguration } from "./decision-configuration.js";
import { AgentStateError } from "./state-error.js";
import { projectAgentContext } from "./context-projection.js";
import type { AgentInvocationStage } from "./invocation-records.js";
import type { AgentActionPlan } from "./workspace-records.js";

const managementQueues=new WeakMap<AgentApplicationDependencies["store"],Map<string,Promise<unknown>>>();

function boundPeerDescriptions(peers: readonly AgentPeerSummary[], characters: number) {
  return peers.map(peer => {
    if (peer.purpose.length <= characters && (peer.notes?.length ?? 0) <= characters) return peer;
    return { ...peer, purpose: peer.purpose.slice(0, characters),
      purposeOmittedCharacters: (peer.purposeOmittedCharacters ?? 0) + Math.max(0, peer.purpose.length - characters),
      ...(peer.notes !== undefined ? { notes: peer.notes.slice(0, characters),
        notesOmittedCharacters: (peer.notesOmittedCharacters ?? 0) + Math.max(0, peer.notes.length - characters) } : {}) };
  });
}

/** Only management calls are metered here. The ordinary session's gateway is never wrapped. */
export function createAgentManagementModel(dependencies:AgentApplicationDependencies) {
  const invoke=async (input:Readonly<{agentId:string;missionId:string;stage:AgentInvocationStage;instructions:string;
    signal:AbortSignal;format?:Record<string,unknown>;assessment?:string;plan?:AgentActionPlan;readSessionId?:string;returnedExchangeId?:string;returnedAttemptId?:string;
    progress?:ProgressObservation;conversationMessageId?:string;inflightAttemptId?:string;peerClarification?:Readonly<{exchangeId:string;childMissionId:string;questionMessageId:string;clarificationId:string}>}>) => {
    const state=await dependencies.store.read();
    const agent=state.agents.find((entry)=>entry.id===input.agentId)!;
    const mission=state.missions.find((entry)=>entry.id===input.missionId)!;
    if(!agent||!mission) throw new AgentStateError("agents_model_owner_missing");
    if(!input.peerClarification&&state.mailbox.some((entry)=>entry.missionId===mission.id&&(entry.status!=="answered"||entry.outcome===null))) throw new AgentStateError("agents_exchange_allowance_reserved");
    if(state.mailbox.some((entry)=>entry.clarifications?.some((item)=>item.childMissionId===mission.id&&(item.status==="reserved"||item.status==="unknown"))))throw new AgentStateError("agents_peer_clarification_pending");
    const configuration=captureAgentDecisionConfiguration(agent.definition,dependencies.config);
    if(!configuration) throw new AgentStateError("agents_model_configuration_unavailable");
    const resolved=resolveModelInvocation({agentMode:"reasoning",modelPreference:{profileId:agent.definition.modelProfileId,scope:"all"},modelPolicy:dependencies.config.models});
    const runner=loadRequestRunnerConfig(dependencies.config.requestRunner);
    const capacity=resolved.profile.contextWindowTokens-runner.context.outputReserveTokens-runner.context.safetyReserveTokens;
    const peers=!input.progress && !input.returnedAttemptId && dependencies.peers?await dependencies.peers(agent.id):[];
    const exchange=input.peerClarification?state.mailbox.find((entry)=>entry.id===input.peerClarification!.exchangeId):undefined;
    const question=input.peerClarification?state.messages.find((entry)=>entry.id===input.peerClarification!.questionMessageId):undefined;
    const child=input.peerClarification?state.missions.find((entry)=>entry.id===input.peerClarification!.childMissionId):undefined;
    if(input.peerClarification&&(!exchange||!question||!child))throw new AgentStateError("agents_peer_question_invalid");
    const peerQuestion=input.peerClarification?{exchangeId:exchange!.id,childMissionId:child!.id,questionMessageId:question!.id,question:question!.text,assignment:exchange!.assignment}:undefined;
    const context={...input,state,peers,...(peerQuestion?{peerQuestion}:{})};
    let messages=input.progress ? progressContext(state,mission,input.progress.source) : projectAgentContext(context);
    const estimate=()=>estimateMessagesTokens(messages,resolved.profile.context.tokenEstimation)+estimateTextTokens(JSON.stringify(input.format??{}),resolved.profile.context.tokenEstimation);
    if (!input.progress && estimate() > capacity) {
      // Give the latest conversation exchange the available window before clipping its text.
      messages = projectAgentContext({...context, historyLimit:4, evidenceCharacters:1500, conversationHistory:{messages:2}});
      if (estimate() > capacity) {
        for (const characters of [undefined, 3000, 1500, 500]) {
          messages = projectAgentContext({...context, historyLimit:0, evidenceCharacters:500, conversationHistory:{messages:2, characters}});
          if (estimate() <= capacity) break;
        }
      }
      // Keep every visible peer identity; shorten only optional routing descriptions.
      for (const characters of [1000, 500, 250, 100, 0]) {
        if (!peers.length || estimate() <= capacity) break;
        messages = projectAgentContext({...context, peers:boundPeerDescriptions(peers, characters),
          historyLimit:0, evidenceCharacters:500, conversationHistory:{messages:2, characters:500}});
      }
    }
    if(estimate()>capacity) throw new AgentStateError("agents_context_capacity_exceeded");
    input.signal.throwIfAborted();
    let remaining=mission.limits.maxTotalTokens-mission.usage.totalTokens;
    if (input.progress) {
      const live = await input.progress.current();
      if (!sameProgressCheckpoint(input.progress.source, live)) throw new AgentStateError("agents_progress_outdated");
      remaining -= live?.workUsage?.totalTokens ?? 0;
      const usedCalls = mission.usage.modelCalls + (live?.workUsage?.modelCalls ?? 0);
      if (usedCalls >= mission.limits.maxModelCalls || estimate() + runner.context.outputReserveTokens > remaining)
        throw new AgentStateError("agents_progress_allowance_unavailable");
    }
    const reservedTokens=Math.min(dependencies.managementTokenReservation??remaining,remaining,child?child.limits.maxTotalTokens-child.usage.totalTokens:remaining);
    if(reservedTokens<1) throw new AgentStateError("agents_token_limit_reached");
    const invocationId=input.progress ? `progress:${mission.id}` : input.conversationMessageId?conversationInvocationId(mission.id,input.conversationMessageId,agent.revision,mission.revision):randomUUID();
    const reservation={agentId:agent.id,missionId:mission.id,invocationId,agentRevision:agent.revision,missionRevision:mission.revision,configuration,reservedTokens};
    if(input.peerClarification)await dependencies.store.commitApplication({kind:"reserve_peer_clarification",...reservation,...input.peerClarification});
    else if(input.conversationMessageId)await dependencies.store.commitApplication({kind:"reserve_conversation_reply",...reservation,messageId:input.conversationMessageId});
    else await dependencies.store.commitApplication({kind:"reserve_invocation",...reservation,stage:input.stage});
    let response:Awaited<ReturnType<typeof dependencies.models.invoke>>;
    try {
      response=await dependencies.models.invoke({agentMode:"reasoning",messages,modelPreference:{profileId:agent.definition.modelProfileId,scope:"all"},
        modelPolicy:dependencies.config.models,abortSignal:input.signal,debugRequestId:invocationId,...(input.format?{format:input.format}:{})});
    } catch(error) {
      await dependencies.store.commitApplication({kind:"settle_invocation",agentId:agent.id,invocationId,usage:null}); throw error;
    }
    const usage=normalizeModelTokenUsage(response.meta.usage);
    const text=response.text.trim();
    const publicReport = input.progress && usage && !input.signal.aborted && text.length > 0 && text.length <= 360 &&
      sameProgressCheckpoint(input.progress.source, await input.progress.current().catch(() => null));
    await dependencies.store.commitApplication({kind:"settle_invocation",agentId:agent.id,invocationId,
      usage:usage?{totalTokens:usage.totalTokens,cost:{kind:"unknown"}}:null,
      ...(publicReport ? {progressReport:{workId:input.progress!.source.workId,text}} : {})});
    if(!usage) throw new AgentStateError("agents_management_usage_unknown");
    if(!response.text.trim()) throw new AgentStateError("agents_management_output_empty");
    return {text:response.text,invocationId};
  };
  return (input:Parameters<typeof invoke>[0]):ReturnType<typeof invoke> => {
    let queues=managementQueues.get(dependencies.store);if(!queues){queues=new Map();managementQueues.set(dependencies.store,queues);}
    const pending=(queues.get(input.agentId)??Promise.resolve()).catch(()=>undefined).then(()=>invoke(input));
    queues.set(input.agentId,pending);
    void pending.finally(()=>{if(queues!.get(input.agentId)===pending)queues!.delete(input.agentId);}).catch(()=>undefined);
    return pending;
  };
}
