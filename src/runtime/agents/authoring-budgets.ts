import type { RequestExecutionPolicyId } from "../../shared/request-execution-policy.js";
import type { AgentMissionLimits } from "./agent-records.js";

// Each tier applies to a whole task, including management calls and ordinary work sessions.
const tiers = {
  short:    { generalTokens: 120_000, researchCodingTokens: 300_000, eaCalls: 24, superCalls: 48, attempts: 3, noProgress: 2, clarifications: 2 },
  standard: { generalTokens: 300_000, researchCodingTokens: 800_000, eaCalls: 64, superCalls: 128, attempts: 6, noProgress: 2, clarifications: 4 },
  deep:     { generalTokens: 900_000, researchCodingTokens: 1_600_000, eaCalls: 128, superCalls: 256, attempts: 12, noProgress: 3, clarifications: 6 },
};

function recommendedAgentLimits(budget: keyof typeof tiers, role?: string, executionPolicy?: RequestExecutionPolicyId): AgentMissionLimits {
  const tier = tiers[budget];
  const researchOrCoding = role === "research" || role === "coding";
  return {
    maxAttempts: tier.attempts,
    maxModelCalls: executionPolicy === "supervisor-worker-v1" ? tier.superCalls : tier.eaCalls,
    maxTotalTokens: researchOrCoding ? tier.researchCodingTokens : tier.generalTokens,
    maxConsecutiveNoProgress: tier.noProgress,
    maxClarificationRounds: tier.clarifications,
  };
}

export function agentBudgetPresets(role?: string, executionPolicy?: RequestExecutionPolicyId) {
  return {
    short: recommendedAgentLimits("short", role, executionPolicy),
    standard: recommendedAgentLimits("standard", role, executionPolicy),
    deep: recommendedAgentLimits("deep", role, executionPolicy),
  };
}
