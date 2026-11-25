/** Human-facing presentation of the retained reason, including missions saved by earlier versions. */
export function agentPlanRecoveryNotice(mission, attempts = [], recovery) {
  if (mission?.status !== "awaiting_user_decision" || mission.waitingReason !== "agents_plan_invalid") return null;
  const hasResult = recovery === undefined ? attempts.some((attempt) => attempt.agentId === mission.agentId && attempt.missionId === mission.id &&
    attempt.status === "settled" && attempt.result?.status === "completed") : recovery === "work_returned";
  return hasResult
    ? "The work session returned a result. I paused because I couldn’t verify my next step."
    : "I paused because I couldn’t verify my next step.";
}
