import { createAgentWorkGuidance } from "./work-guidance.js";
import { agentBudgetStopReason, createAgentLiveBudgetMonitor } from "./live-budget-monitor.js";
import { reconcileAgentWork } from "./work-reconciliation.js";
import { currentReturnedWorkAttempt } from "./work-result-context.js";
import { recordedWorkReplyCommand } from "./workspace-evidence.js";
import { agentExhaustionReply } from "./exhaustion-reply.js";
import { initialAgentMessage, pendingAutomaticQuestion, recordedMessageIntent, unansweredConversationMessages } from "./conversation-intent.js";
import { createAgentPeerClarificationService } from "./peer-clarification-service.js";
import { createAgentConversationService } from "./conversation-service.js";
import { randomUUID } from "node:crypto";
import type { AgentApplicationDependencies, AgentApplicationService, AgentMessageInput } from "./application-contracts.js";
import { createAgentResponsibilityController } from "./responsibility-controller.js";
import { AgentStateError } from "./state-error.js";
import type { AgentState } from "./agent-records.js";
import { agentNeedsNewBudget } from "./conversation-availability.js";
import { projectAgentDetail } from "./application-view.js";
import { isAgentMissionOpen } from "./workspace-state.js";
import { UNKNOWN_AGENT_WORK } from "./application-dispatch.js";
import { readAgentMissionLimits, requireAgentText } from "./record-validation.js";

/** Agent-owned lifecycle. No ordinary runtime request, tool or execution policy is modified. */
export function createAgentApplication(deps:AgentApplicationDependencies):AgentApplicationService {
  const active=new Map<string,{missionId:string;controller:AbortController;promise:Promise<void>}>();
  const conversations=new Map<string,{agentId:string;missionId:string;controller:AbortController;promise:Promise<void>}>();
  const reply=createAgentConversationService(deps, withdrawWork);
  const withdrawals = new Map<string, Promise<void>>();
  const cancellations=new Map<string,Promise<Awaited<ReturnType<AgentApplicationService["cancel"]>>>>();
  const failures=new Map<string,unknown>();
  const refreshing = new Map<string, Promise<Awaited<ReturnType<AgentApplicationService["refresh"]>>>>();
  const run=createAgentResponsibilityController(deps);
  let closed=false;
  const workGuidance = createAgentWorkGuidance(deps);
  const budgetMonitor = createAgentLiveBudgetMonitor(deps, (agentId, missionId) => {
    const job = active.get(agentId);
    if (job?.missionId === missionId) job.controller.abort(new Error("Agent work allowance reached."));
    for (const conversation of conversations.values()) {
      if (conversation.missionId === missionId) conversation.controller.abort(new Error("Agent work allowance reached."));
    }
  });
  function launch(agentId:string,missionId:string):void {
    if(closed||active.has(agentId)) return;
    const controller=new AbortController();
    const promise=Promise.resolve().then(()=>run(agentId,missionId,controller.signal)).catch(async(error:unknown)=>{
      const state=await deps.store.read();
      const mission=state.missions.find((entry)=>entry.id===missionId);
      if(!mission||!isAgentMissionOpen(mission)) return;
      if (agentBudgetStopReason(mission)) return;
      const code=error instanceof AgentStateError?error.code:controller.signal.aborted?"agents_interrupted":"agents_controller_failed";
      const recorded = !controller.signal.aborted && recordedWorkReplyCommand(state, mission, code);
      if (recorded) {
        await deps.store.commitApplication(recorded);
        return;
      }
      const exhausted=/limit_reached$/.test(code);
      if(exhausted) {
        const systemOnly = code === "agents_token_limit_reached" || code === "agents_model_call_limit_reached";
        await deps.store.commitApplication({kind:"finish_agent_turn",agentId,missionId,status:"exhausted",reason:systemOnly ? `agents_budget_stop:${code}` : code,
          ...(systemOnly ? {} : {messageId:randomUUID(),text:agentExhaustionReply(state,mission,code)})});
      } else await deps.store.commitApplication({kind:"mark_agent_waiting",agentId,missionId,reason:code});
    }).catch((error:unknown)=>{failures.set(agentId,error);}).finally(()=>{if(active.get(agentId)?.controller===controller) active.delete(agentId);});
    active.set(agentId,{missionId,controller,promise});
  }
  function currentDetail(state: AgentState, agentId: string) {
    const replyingTo = [...conversations].filter(([, job]) => job.agentId === agentId && !job.controller.signal.aborted).map(([id]) => id);
    return projectAgentDetail(state, agentId, active.has(agentId), replyingTo);
  }
  const detail:AgentApplicationService["detail"]=async(agentId)=>currentDetail(await deps.store.read(),agentId);
  function launchConversation(agentId: string, missionId: string, messageId: string) {
    if (closed || conversations.has(messageId)) return;
    const controller = new AbortController();
    const promise = reply(agentId, missionId, messageId, controller.signal)
      .catch((error: unknown) => { failures.set(agentId, error); })
      .finally(() => { conversations.delete(messageId); });
    conversations.set(messageId, {agentId, missionId, controller, promise});
  }

  async function send(agentId:string,input:AgentMessageInput,source:Parameters<AgentApplicationService["receive"]>[2]|null=null) {
    if(closed) throw new AgentStateError("agents_application_closed");
    requireAgentText(input.messageId,"messageId");requireAgentText(input.text,"text");
    if(input.text.length>32000||!["task","message","auto"].includes(input.intent)) throw new AgentStateError("agents_message_invalid");
    if ((source || input.expectedAgentRevision !== undefined) && input.intent !== "task") throw new AgentStateError("agents_message_invalid");
    const state=await deps.store.read(),current=currentDetail(state,agentId);
    const previous=state.messages.find((entry)=>entry.id===input.messageId);
    if(previous) {
      if(previous.agentId!==agentId||previous.role==="assistant"||previous.text!==input.text||recordedMessageIntent(previous)!==input.intent||JSON.stringify(previous.source)!==JSON.stringify(source)) throw new AgentStateError("agents_message_identity_conflict");
      return current;
    }
    const limits=input.limits??current.agent.definition.defaultLimits??null;
    if(limits)readAgentMissionLimits(limits);
    const proposedMissionId=randomUUID();
    const question=input.intent==="auto"&&current.mission?pendingAutomaticQuestion(state,current.mission.id):undefined;
    const admission=await deps.store.admitMessage({kind:"open_agent_turn",agentId,missionId:proposedMissionId,messageId:input.messageId,text:input.text,intent:input.intent,limits,source,
      ...(question?{questionId:question.id}:{}),...(input.expectedAgentRevision===undefined?{}:{expectedAgentRevision:input.expectedAgentRevision})});
    if (!admission.changed) return detail(agentId);
    const message=admission.state.messages.find((entry)=>entry.id===input.messageId)!;
    if (message.purpose === "conversation") launchConversation(agentId,message.missionId,message.id);
    else if (message.purpose === "clarification" || message.missionId === proposedMissionId) {
      // A user may answer as soon as the question is durable, before the old controller returns.
      await active.get(agentId)?.promise;
      launch(agentId,message.missionId);
    }
    return detail(agentId);
  }
  async function withdrawWork(agentId: string, missionId: string, attemptId: string, recovering = false): Promise<void> {
    const pending = withdrawals.get(attemptId);
    if (pending) return pending;
    const operation = (async () => {
      const state = await deps.store.read();
      const attempt = state.attempts.find(entry => entry.id === attemptId && entry.agentId === agentId && entry.missionId === missionId);
      if (!attempt || !state.messages.some(entry => entry.agentId === agentId && entry.missionId === missionId && entry.withdrawnAttemptId === attemptId)) return;
      const job = active.get(agentId);
      if (job?.missionId === missionId) job.controller.abort(new Error("User withdrew the work request."));
      if (attempt.status === "settled") return;
      if (recovering) {
        const observed = await deps.work.inspect(attempt.request).catch(() => UNKNOWN_AGENT_WORK);
        if (observed.status !== "running" && observed.status !== "awaiting_approval") {
          await deps.store.commitApplication({kind:"observe_agent_work",agentId,attemptId,result:observed});
          return;
        }
      }
      const result = await deps.work.cancel?.(attempt.request).catch(() => UNKNOWN_AGENT_WORK) ?? UNKNOWN_AGENT_WORK;
      await deps.store.commitApplication({kind:"observe_agent_work",agentId,attemptId,result});
    })().finally(() => withdrawals.delete(attemptId));
    withdrawals.set(attemptId, operation);
    return operation;
  }
  async function cancelInternal(agentId:string,missionId:string) {
    let retained: AgentState;
    try {
      retained = await deps.store.commitApplication({kind:"cancel_mission",agentId,missionId,reason:"Cancelled by the user."});
    } catch (error) {
      if (error instanceof AgentStateError && error.code === "agents_mission_terminal") return detail(agentId);
      throw error;
    }
    const activeJob = active.get(agentId);
    if (activeJob?.missionId === missionId) activeJob.controller.abort(new Error("Agent task cancelled."));
    for (const job of conversations.values()) {
      if (job.missionId === missionId) job.controller.abort(new Error("Agent task cancelled."));
    }
    for(const exchange of retained.mailbox.filter((entry)=>entry.missionId===missionId&&entry.status!=="answered")) {
      const assignment=retained.messages.find((entry)=>entry.agentId===exchange.recipientAgentId&&entry.source?.agentId===agentId&&entry.source.missionId===missionId&&entry.source.correlationId===exchange.id);
      if (assignment) await cancel(exchange.recipientAgentId, assignment.missionId);
    }
    for(const attempt of retained.attempts.filter((entry)=>entry.missionId===missionId&&entry.status!=="settled")) {
      const result=deps.work.cancel?await deps.work.cancel(attempt.request).catch(()=>UNKNOWN_AGENT_WORK):UNKNOWN_AGENT_WORK;
      await deps.store.commitApplication({kind:"observe_agent_work",agentId,attemptId:attempt.id,result});
    }
    return detail(agentId);
  }
  async function cancel(agentId:string,expectedMissionId?:string) {
    const current = await detail(agentId);
    const mission = current.mission;
    if (!mission || (expectedMissionId !== undefined && mission.id !== expectedMissionId)) return current;
    const existing = cancellations.get(mission.id);
    if (existing) return existing;
    if (!isAgentMissionOpen(mission)) return current;
    const pending = cancelInternal(agentId,mission.id).finally(() => cancellations.delete(mission.id));
    cancellations.set(mission.id,pending);
    return pending;
  }
  async function refresh(agentId:string,expectedMissionId?:string) {
    const existing = refreshing.get(agentId);
    if (existing) return existing;
    const operation = (async () => {
      const settled = await reconcileAgentWork(deps, agentId, active.get(agentId)?.missionId);
      await workGuidance.inspect(agentId);
      if (await budgetMonitor.inspect(agentId)) return detail(agentId);
      const state = await deps.store.read();
      const current = currentDetail(state, agentId);
      const mission = current.mission;
      if (!mission || mission.status !== "active" || active.has(agentId)) return current;
      if (expectedMissionId !== undefined && mission.id !== expectedMissionId) return current;
      const hasWorkContinuation = settled.has(mission.id) || !!currentReturnedWorkAttempt(state, mission);
      if (hasWorkContinuation) launch(agentId, mission.id);
      return detail(agentId);
    })().finally(() => refreshing.delete(agentId));
    refreshing.set(agentId, operation);
    return operation;
  }
  async function pause(agentId:string) {
    const current=await detail(agentId),mission=current.mission;
    if(!mission||!isAgentMissionOpen(mission)) throw new AgentStateError("agents_mission_not_active");
    await deps.store.commitApplication({kind:"mark_agent_waiting",agentId,missionId:mission.id,reason:"Paused by the user."});
    active.get(agentId)?.controller.abort(new Error("Agent task paused."));
    for(const entry of conversations.values()) if(entry.agentId===agentId) entry.controller.abort(new Error("Agent task paused."));
    for(const attempt of current.attempts.filter((entry)=>entry.missionId===mission.id&&entry.status!=="settled")) {
      const observed=deps.work.cancel?await deps.work.cancel(attempt.request).catch(()=>UNKNOWN_AGENT_WORK):UNKNOWN_AGENT_WORK;
      const result=observed.status==="running"||observed.status==="awaiting_approval"?UNKNOWN_AGENT_WORK:observed;
      await deps.store.commitApplication({kind:"observe_agent_work",agentId,attemptId:attempt.id,result});
    }
    await active.get(agentId)?.promise;
    return detail(agentId);
  }
  const resolve:AgentApplicationService["resolve"]=async(agentId,input)=>{
      if(input.action==="cancel") return cancel(agentId);
      if(input.action!=="continue") throw new AgentStateError("agents_resolution_invalid");
      let state = await deps.store.read();
      const waiting = currentDetail(state, agentId).mission;
      if (waiting?.status !== "awaiting_user_decision") throw new AgentStateError("agents_mission_not_waiting");
      const pendingReplies = [...conversations.values()].filter((job) => job.missionId === waiting.id);
      if (pendingReplies.length) {
        await Promise.all(pendingReplies.map((job) => job.promise));
        state = await deps.store.read();
      }
      const mission = currentDetail(state, agentId).mission;
      if (mission?.id !== waiting.id || mission.status !== "awaiting_user_decision" || mission.revision !== waiting.revision)
        throw new AgentStateError("agents_mission_not_waiting");
      requireAgentText(input.text,"resolution.text");
      if (agentBudgetStopReason(mission) && state.attempts.some(attempt => attempt.missionId === mission.id && attempt.status !== "settled" && !attempt.userResolved))
        throw new AgentStateError("agents_work_unresolved");
      const origin=initialAgentMessage(state,mission.id);
      if(agentNeedsNewBudget(state,mission.id)) {
        if(!input.limits) throw new AgentStateError("agents_unknown_resolution_requires_limits");
        readAgentMissionLimits(input.limits);
        await cancel(agentId,mission.id);
        await active.get(agentId)?.promise;
        return send(agentId,{messageId:randomUUID(),text:input.text,intent:origin?.purpose==="conversation"?"message":origin?.inputIntent??"task",limits:input.limits});
      }
      await deps.store.commitApplication({kind:"append_agent_message",agentId,missionId:mission.id,messageId:randomUUID(),role:"user",purpose:"clarification",text:input.text});
      await deps.store.commitApplication({kind:"resume_agent_turn",agentId,missionId:mission.id,text:input.text});
      if(origin?.purpose==="conversation") {
        for(const message of unansweredConversationMessages(state,mission.id))launchConversation(agentId,mission.id,message.id);
      } else launch(agentId,mission.id);
      return detail(agentId);
    };
  return {
    detail,send,pause,resolve,answerPeerClarification:createAgentPeerClarificationService(deps,launch),async steer(agentId,input){requireAgentText(input.text,"steering.text");await pause(agentId);return resolve(agentId,{action:"continue",...input});},receive:(agentId,input,source)=>send(agentId,input,source),cancel,refresh,
    async snapshot(){const state=await deps.store.read();return {revision:state.revision,agents:state.agents.map((agent)=>currentDetail(state,agent.id))};},
    async associatedSessionIds(){return (await deps.store.read()).sessions.map((entry)=>entry.sessionId);},
    isBusy:()=>active.size>0||conversations.size>0,
    async whenIdle(agentId){await Promise.all([...conversations.values()].filter((entry)=>!agentId||entry.agentId===agentId).map((entry)=>entry.promise));if(agentId) await active.get(agentId)?.promise;else await Promise.all([...active.values()].map((entry)=>entry.promise));if(agentId&&failures.has(agentId))throw failures.get(agentId);if(!agentId&&failures.size)throw failures.values().next().value;},

    async recover(){
      let state=await deps.store.reconcile();
      const unsettled = new Set(state.attempts.filter(entry => entry.status !== "settled").map(entry => entry.id));
      for (const message of state.messages) if (message.withdrawnAttemptId && unsettled.has(message.withdrawnAttemptId))
        await withdrawWork(message.agentId, message.missionId, message.withdrawnAttemptId, true);
      for (const mission of state.missions) {
        if (mission.waitingReason !== "agents_plan_rejected_work_requires_acceptance") continue;
        const delivery = recordedWorkReplyCommand(state, mission, mission.waitingReason);
        if (delivery) state = await deps.store.commitApplication(delivery);
      }
      for(const exchange of state.mailbox)for(const record of exchange.clarifications??[])if(record.status==="reserved"&&!active.has(exchange.agentId))await deps.store.commitApplication({kind:"settle_peer_clarification",agentId:exchange.agentId,missionId:exchange.missionId,exchangeId:exchange.id,clarificationId:record.id,outcome:"unknown",text:null});
      state=await deps.store.read();
      for (const agent of state.agents) {
        const hasClosedWork = state.attempts.some(attempt => attempt.agentId === agent.id && (attempt.status !== "settled" || attempt.result?.usage === null) &&
          state.missions.some(mission => mission.id === attempt.missionId && mission.status !== "active"));
        const hasCancelledExchange = state.mailbox.some(exchange => exchange.agentId === agent.id && exchange.status !== "answered" &&
          state.missions.some(mission => mission.id === exchange.missionId && mission.status === "cancelled"));
        if (hasClosedWork || hasCancelledExchange) await reconcileAgentWork(deps, agent.id, active.get(agent.id)?.missionId);
      }
      state=await deps.store.read();
      for(const mission of state.missions.filter((entry)=>entry.status==="active"&&!active.has(entry.agentId)&&![...conversations.values()].some((job)=>job.agentId===entry.agentId))) {
        let parked=false;
        for(const attempt of state.attempts.filter((entry)=>entry.missionId===mission.id&&entry.status!=="settled")) {
          const observed=await deps.work.inspect(attempt.request).catch(()=>UNKNOWN_AGENT_WORK);
          const result=observed.status==="running"?UNKNOWN_AGENT_WORK:observed;
          await deps.store.commitApplication({kind:"observe_agent_work",agentId:mission.agentId,attemptId:attempt.id,result});
          parked ||= result.status==="awaiting_approval";
        }
        if(!parked) await deps.store.commitApplication({kind:"mark_agent_waiting",agentId:mission.agentId,missionId:mission.id,reason:"Recovered after interruption. Review the recorded work before continuing."});
      }
    },
    async shutdown(){closed=true;for(const entry of [...active.values(),...conversations.values()])entry.controller.abort(new Error("Agent application stopped."));await Promise.all([...active.values(),...conversations.values()].map((entry)=>entry.promise));},
  };
}
