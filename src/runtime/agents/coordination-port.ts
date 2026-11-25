import type { AgentMissionLimits } from "./agent-records.js";
import { agentRolePurpose, agentOutputLabels } from "./authoring-prompt.js";
import type { AgentApplicationService, AgentCoordinationRequest, AgentPeerSummary } from "./application-contracts.js";
import type { FileAgentStateStore } from "./file-store.js";
import type { AgentPeerUsage } from "./workspace-records.js";

function delegatedLimits(requested: AgentMissionLimits, receiver: AgentMissionLimits | undefined): AgentMissionLimits {
  if (!receiver) throw new Error("agents_peer_limits_required");
  return Object.fromEntries(Object.entries(requested).map(([key, value]) => [key,
    Math.min(value, receiver[key as keyof AgentMissionLimits])])) as AgentMissionLimits;
}
function waitForPeerChange(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, 1000);
    signal.addEventListener("abort", aborted, { once: true });
  });
}
/** A bounded peer exchange between Agents. It does not call or modify the execution core. */
export function createAgentCoordinationPort(input: { store: FileAgentStateStore; application(): AgentApplicationService }) {
  return {
    async peers(agentId: string): Promise<readonly AgentPeerSummary[]> {
      if (agentId !== "abot") return [];
      return (await input.application().snapshot()).agents.filter((entry) => entry.agent.id !== agentId && entry.agent.status === "active")
        .map((entry) => {
          const definition = entry.agent.definition;
          const onboarding = definition.onboarding;
          const focus = onboarding ? agentRolePurpose(onboarding) : undefined;
          const fallback = !focus?.trim();
          const purpose = fallback ? definition.basePrompt : focus!;
          const purposeLimit = fallback ? 500 : 2000;
          const notes = onboarding?.notes ?? "";
          return { id: entry.agent.id, name: definition.name, modelProfileId: definition.modelProfileId,
            purpose: purpose.slice(0, purposeLimit), status: entry.status,
            source: fallback ? "base_prompt_fallback" as const : "onboarding" as const,
            notes: notes.slice(0, 2000), preferredOutputs: onboarding ? agentOutputLabels(onboarding.outputs) : [],
            purposeOmittedCharacters: Math.max(0, purpose.length - purposeLimit),
            notesOmittedCharacters: Math.max(0, notes.length - 2000) };
        });
    },
    async coordinate(request: AgentCoordinationRequest): Promise<{ text: string; usage: AgentPeerUsage | null; outcome: "completed" | "exhausted" | "cancelled" }> {
      if (request.senderAgentId !== "abot" || request.recipientAgentId === "abot") throw new Error("agents_peer_target_invalid");
      const app = input.application();
      const receiver = await app.detail(request.recipientAgentId);
      if (receiver.agent.status !== "active" || !["idle", "failed"].includes(receiver.status)) throw new Error("agents_peer_busy");
      const rank = { ask: 0, full_access: 1, full_plus: 2 };
      if (rank[receiver.agent.definition.toolPermissionMode] > rank[request.toolPermissionMode]) throw new Error("agents_peer_permission_escalation");
      const limits = delegatedLimits(request.limits, receiver.agent.definition.defaultLimits);
      const messageId = `peer:${request.correlationId}`;
      const source = { agentId: request.senderAgentId, missionId: request.missionId, correlationId: request.correlationId };
      request.signal.throwIfAborted();
      const started = await app.receive(receiver.agent.id, { messageId, text: request.assignment, intent: "task",
        expectedAgentRevision: receiver.agent.revision, limits }, source);
      const assignment = started.messages.find((message) => message.id === messageId && message.agentId === receiver.agent.id &&
        message.source?.agentId === source.agentId && message.source.missionId === source.missionId && message.source.correlationId === source.correlationId);
      if (!assignment) throw new Error("agents_peer_mission_missing");
      const missionId = assignment.missionId;
      const handledQuestions = new Set<string>();
      try {
        for (;;) {
          request.signal.throwIfAborted();
          const detail = await app.refresh(receiver.agent.id, missionId);
          const question = detail.peerClarification;
          if (question && question.exchangeId === request.correlationId && question.parentAgentId === request.senderAgentId &&
              question.childMissionId === missionId && !handledQuestions.has(question.questionMessageId)) {
            handledQuestions.add(question.questionMessageId);
            await app.answerPeerClarification({ ...question, childAgentId: receiver.agent.id, signal: request.signal });
          }
          const state = await input.store.read();
          const mission = state.missions.find((entry) => entry.id === missionId);
          if (!mission) throw new Error("agents_peer_mission_missing");
          if (["completed", "exhausted", "cancelled"].includes(mission.status)) {
            const unresolved = state.invocations.some((entry) => entry.missionId === missionId && entry.status !== "settled") ||
              state.attempts.some((entry) => entry.missionId === missionId && (!entry.result?.usage || entry.status === "unknown"));
            const response = [...state.messages].reverse().find((entry) => entry.missionId === missionId && entry.role === "assistant");
            return { outcome: mission.status as "completed" | "exhausted" | "cancelled", text: `${receiver.agent.definition.name} · ${mission.status}\n${response?.text ?? "No final response was recorded."}`,
              usage: unresolved ? null : { modelCalls: mission.usage.modelCalls, totalTokens: mission.usage.totalTokens,
                attempts: mission.usage.attempts, clarificationRounds: mission.usage.clarificationRounds } };
          }
          await waitForPeerChange(request.signal);
        }
      } catch (error) {
        if (request.signal.aborted) await app.cancel(receiver.agent.id, missionId).catch(() => undefined);
        throw error;
      }
    },
  };
}
