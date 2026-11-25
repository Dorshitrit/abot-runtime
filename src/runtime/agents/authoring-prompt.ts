import type { AgentOnboarding } from "./agent-records.js";

const AGENT_FOCUS = Object.freeze({
  research: { purpose: "Research questions, compare options, and explain findings" },
  writing: { purpose: "Draft and improve written content" },
  coding: { purpose: "Help with software development and troubleshooting" },
  planning: { purpose: "Turn goals and information into clear, organized plans" },
  everyday: { purpose: "Help with everyday questions, decisions, and practical tasks" },
  custom: { purpose: "" },
});
const AGENT_OUTPUTS = Object.freeze({ recommendations: "Clear recommendations", summaries: "Concise summaries", comparisons: "Side-by-side comparisons", drafts: "Ready-to-use drafts", plans: "Actionable plans", code: "Working code" });
const AGENT_STYLES = Object.freeze({ concise: { instruction: "Be concise and practical. Lead with the useful answer." }, balanced: { instruction: "Give the answer and the key reasoning needed to use it." }, detailed: { instruction: "Explain thoroughly when useful, with evidence and concrete examples." } });
const AGENT_ASKS = Object.freeze({ unclear: "An unclear goal", tradeoffs: "Meaningful tradeoffs", direction: "A change of direction" });
const AGENT_UPDATES = Object.freeze({ needed: { instruction: "Update me when my input is needed and when work is complete." }, milestones: { instruction: "Update me at meaningful milestones and when work is complete." }, brief: { instruction: "Provide brief updates as meaningful progress is made." } });

export function agentRolePurpose(draft: Pick<AgentOnboarding, "role" | "custom">) {
  return draft.role === "custom" ? draft.custom : AGENT_FOCUS[draft.role]?.purpose;
}

export function agentOutputLabels(outputs: AgentOnboarding["outputs"]) {
  return outputs.map((id) => AGENT_OUTPUTS[id]).filter(Boolean);
}

export function buildAgentBasePrompt(name: string, draft: AgentOnboarding) {
  const quote = (value: string | undefined) => JSON.stringify(String(value || ""));
  const purpose = agentRolePurpose(draft);
  return [
    `You are ${quote(name || "New agent")}, a persistent agent.`,
    `Your standing focus: ${quote(purpose)}.`,
    draft.outputs.length ? `Prefer these deliverables: ${agentOutputLabels(draft.outputs).join("; ")}.` : "",
    AGENT_STYLES[draft.style]?.instruction, AGENT_UPDATES[draft.updates]?.instruction,
    draft.asks.length ? `Ask me about: ${draft.asks.map((id) => AGENT_ASKS[id]?.toLowerCase()).filter(Boolean).join("; ")}.` : "",
    draft.notes ? `Additional user-provided guidance (verbatim): ${quote(draft.notes)}.` : "",
    "Keep your own conversation context. Use only the shared memory and session evidence explicitly provided to you.",
    "These preferences define your role and communication. Work on the current user request or an accepted task delegated by ABot within existing permissions. They do not grant new tool access or permission to read other agents’ conversations. Shared memories are background, not new assignments.",
  ].filter(Boolean).join("\n\n");
}
