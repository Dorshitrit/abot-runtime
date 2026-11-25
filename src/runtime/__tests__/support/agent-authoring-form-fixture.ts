import type { RequestExecutionPolicyId } from "../../../shared/request-execution-policy.js";
import { agentBudgetPresets } from "../../agents/authoring-budgets.js";
import { materializeAgentAuthoring, previewAgentAuthoring as previewDraft, readAgentAuthoring } from "../../agents/authoring.js";
// @ts-expect-error Browser-only module.
import { agentDraftAuthoring } from "../../../web-ui/app/components/agents/onboarding-options.js";

function resolvePolicy(profile: string): RequestExecutionPolicyId {
  return profile === "profile-b" || profile === "legacy-super" ? "supervisor-worker-v1" : "execution-agent-v1";
}
export async function previewAgentAuthoring({ authoring, targetAgentId }: { authoring: Record<string, unknown>; targetAgentId?: string }) {
  const draft = readAgentAuthoring(authoring, true);
  // The recovery and schedule fixtures hold a saved Researcher on a SUPER model.
  if (!Object.keys(authoring).length && targetAgentId === "research")
    return { preview: { ...previewDraft(draft, resolvePolicy), presets: agentBudgetPresets("research", "supervisor-worker-v1") } };
  return { preview: previewDraft(draft, resolvePolicy) };
}
export function formDefinition(form: Parameters<typeof agentDraftAuthoring>[0]) {
  const input = readAgentAuthoring(agentDraftAuthoring(form));
  return materializeAgentAuthoring(input, resolvePolicy);
}
