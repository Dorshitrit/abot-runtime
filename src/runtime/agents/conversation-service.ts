import type { ModelGatewayJsonSchemaFormat } from "../../model-gateway/types.js";
import { validateJsonSchemaValue } from "../model/json-schema-value.js";
import type { AgentApplicationDependencies } from "./application-contracts.js";
import { conversationBlockMessage, pausedChatBlock } from "./conversation-availability.js";
import { correctableAgentAttempt } from "./conversation-intent.js";
import { createAgentManagementModel } from "./management-model.js";
import { AGENT_CONVERSATION_INSTRUCTIONS, AGENT_INFLIGHT_REPLY_INSTRUCTIONS } from "./management-prompts.js";
import { AgentStateError } from "./state-error.js";
import { AGENT_WORKSPACE_TEXT_LIMIT } from "./workspace-validation.js";

type InflightReply = {disposition: "reply" | "withdraw_work"; text: string};
const inflightReplyFormat: ModelGatewayJsonSchemaFormat = {
  type: "json_schema", name: "persistent_agent_inflight_reply_v1", strict: true,
  schema: {
    type: "object", additionalProperties: false, required: ["disposition", "text"],
    properties: {
      disposition: {type: "string", enum: ["reply", "withdraw_work"]},
      text: {type: "string", minLength: 1, maxLength: AGENT_WORKSPACE_TEXT_LIMIT},
    },
  },
  postValidatedSchemaConstraints: [{keyword: "maxLength", path: "/properties/text/maxLength"}],
};

function readInflightReply(text: string): InflightReply | undefined {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return; }
  if (validateJsonSchemaValue(inflightReplyFormat.schema, value)) return;
  const reply = value as InflightReply;
  if (reply.text.trim() && reply.text.length <= AGENT_WORKSPACE_TEXT_LIMIT) return reply;
}

export function createAgentConversationService(
  deps: AgentApplicationDependencies,
  onWithdraw?: (agentId: string, missionId: string, attemptId: string) => Promise<void>,
) {
  const invoke = createAgentManagementModel(deps);
  return async (agentId: string, missionId: string, messageId: string, signal: AbortSignal): Promise<void> => {
    let admittedDuringWork = false;
    let response: Awaited<ReturnType<typeof invoke>> | undefined;
    let withdrawn: string | undefined;
    try {
      const state = await deps.store.read();
      const mission = state.missions.find(entry => entry.id === missionId && entry.agentId === agentId);
      const source = state.messages.find(entry => entry.id === messageId && entry.missionId === missionId && entry.agentId === agentId);
      if (!mission || !source) return;
      admittedDuringWork = Boolean(source.correctableAttemptId);
      const inflightAttemptId = onWithdraw ? correctableAgentAttempt(state, mission, source)?.id : undefined;
      response = await invoke({agentId, missionId, stage: "authoring", conversationMessageId: messageId, signal,
        ...(inflightAttemptId ? {inflightAttemptId, instructions: AGENT_INFLIGHT_REPLY_INSTRUCTIONS, format: inflightReplyFormat}
          : {instructions: AGENT_CONVERSATION_INSTRUCTIONS})});
      signal.throwIfAborted();
      const reply = inflightAttemptId ? readInflightReply(response.text) : {disposition: "reply", text: response.text};
      // A settled invocation without a publishable reply is visible as a system status.
      if (!reply) return;
      const withdrawAttemptId = reply.disposition === "withdraw_work" ? inflightAttemptId : undefined;
      const committed = await deps.store.commitApplication({kind: "publish_conversation_reply", agentId, missionId, messageId,
        invocationId: response.invocationId, text: reply.text, ...(withdrawAttemptId ? {withdrawAttemptId} : {})});
      if (withdrawAttemptId && committed.messages.some(entry => entry.id === `reply:${messageId}` && entry.missionId === missionId &&
        entry.agentId === agentId && entry.withdrawnAttemptId === withdrawAttemptId)) withdrawn = withdrawAttemptId;
    } catch(error) {
      const code=error instanceof AgentStateError?error.code:"agents_conversation_interrupted";
      if(signal.aborted||code==="agents_conversation_already_claimed"||code==="agents_conversation_revision_changed")return;
      if (admittedDuringWork) {
        // The user can see an unanswered update even when allowance was denied before reservation.
        if (response) throw error;
        return;
      }
      const state = await deps.store.read();
      const mission = state.missions.find((entry) => entry.id === missionId);
      if (!mission || mission.status === "cancelled") return;
      const paused = mission.status === "awaiting_user_decision";
      const block = paused && pausedChatBlock(state, mission);
      const explanation = conversationBlockMessage(code) || (block && conversationBlockMessage(block));
      if (explanation || paused) {
        await deps.store.commitApplication({kind:"publish_conversation_reply",agentId,missionId,messageId,invocationId:null,
          text:explanation || "The agent couldn’t finish this reply. The task is still paused."});
        return;
      }
      await deps.store.commitApplication({kind:"mark_agent_waiting",agentId,missionId,reason:code});
    }
    if (withdrawn) await onWithdraw?.(agentId, missionId, withdrawn);
  };
}
