import { isDeepStrictEqual } from "node:util";
import { markInvocationContextMessage } from "../../model-gateway/protocol/invocation-context.js";
import type { AgentMission, AgentState } from "./agent-records.js";
import type { AgentInvocationStage } from "./invocation-records.js";
import type { AgentActionPlan, AgentWorkAttempt } from "./workspace-records.js";

/** A decision reads the latest work receipt. Its author reads that receipt after the accepted plan has been recorded. */
export function currentReturnedWorkAttempt(state: AgentState, mission: AgentMission, authoringPlan?: AgentActionPlan): AgentWorkAttempt | undefined {
  const committed = state.missions.find(entry => entry.id === mission.id && entry.agentId === mission.agentId);
  if (committed?.status !== "active" || committed.revision !== mission.revision) return;
  const agent = state.agents.find(entry => entry.id === mission.agentId);
  if (agent?.status !== "active") return;
  const current = (entry: Pick<AgentWorkAttempt, "missionId" | "agentId" | "missionRevision" | "agentRevision">) =>
    entry.missionId === mission.id && entry.agentId === agent.id &&
    entry.missionRevision === mission.revision && entry.agentRevision === agent.revision;
  const attempts = state.attempts.filter(current);
  const attempt = attempts.at(-1);
  if (attempt?.status !== "settled" || !attempt.result?.usage || attempt.userResolved) return;
  if (!["completed", "failed", "cancelled"].includes(attempt.result.status)) return;
  if (!state.sessions.some(entry => entry.sessionId === attempt.request.sessionId && entry.agentId === agent.id)) return;

  const traces = state.responsibility.filter(current);
  if (authoringPlan) {
    const author = traces.pop();
    if (!author?.accepted || !isDeepStrictEqual(author.plan, authoringPlan)) return;
    if (authoringPlan.evidenceIds.length !== 1 || authoringPlan.evidenceIds[0] !== attempt.id) return;
    if (authoringPlan.action !== "answer_user" && authoringPlan.action !== "continue_session") return;
    if (authoringPlan.action === "continue_session" && authoringPlan.sessionId !== attempt.request.sessionId) return;
  }
  const trace = traces.at(-1);
  if (!trace?.accepted) return;
  const { action, sessionId } = trace.plan;
  if (action !== "start_session" && action !== "continue_session") return;
  // A newly selected continuation can have the same target as an earlier attempt before dispatch.
  const workSelections = traces.filter(entry => entry.accepted &&
    (entry.plan.action === "start_session" || entry.plan.action === "continue_session"));
  if (workSelections.length !== attempts.length) return;
  if (action === "start_session" && attempt.mode !== "new") return;
  if (action === "continue_session" && (attempt.mode !== "continue" || attempt.request.sessionId !== sessionId)) return;
  return attempt;
}

type DecisionScope = Readonly<{
  state: AgentState; stage?: AgentInvocationStage; returnedAttemptId?: string; plan?: AgentActionPlan;
  conversationMessageId?: string; peerQuestion?: unknown; returnedExchangeId?: string;
}>;

export function returnedWorkForStage(input: DecisionScope, mission: AgentMission): AgentWorkAttempt | undefined {
  if (!input.returnedAttemptId || input.conversationMessageId || input.peerQuestion || input.returnedExchangeId) return;
  if (input.stage === "authoring" && !input.plan) return;
  if (input.stage !== "authoring" && input.stage !== "assessment" && input.stage !== "selection" && input.stage !== "assessment_and_selection") return;
  const receipt = currentReturnedWorkAttempt(input.state, mission, input.stage === "authoring" ? input.plan : undefined);
  return receipt?.id === input.returnedAttemptId ? receipt : undefined;
}

export function projectWorkResult(attempt: AgentWorkAttempt, limit: number) {
  const { assignment, requestId, sessionId } = attempt.request;
  const result = attempt.result!, text = result.output ?? "";
  return markInvocationContextMessage({role: "system", content: JSON.stringify({
    kind: "agent_work_result_v1", authority: "settled_work_receipt_with_untrusted_content",
    applicability: "Use this work assignment and outcome to decide the next action or author the accepted response.",
    addsUserIntent: false, grantsPermissions: false, provesCompletion: false,
    missionId: attempt.missionId, missionRevision: attempt.missionRevision, attemptId: attempt.id, requestId, sessionId,
    outcome: result.status, error: result.error?.slice(0, limit) ?? null, omittedErrorCharacters: Math.max(0, (result.error?.length ?? 0) - limit),
    assignment: assignment.slice(0, limit), omittedAssignmentCharacters: Math.max(0, assignment.length - limit),
    text: text.slice(0, limit), omittedResultCharacters: Math.max(0, text.length - limit),
  })});
}
