import type { SupervisorDelegateRoleId } from "./contracts.js";

const ROLE_GUIDANCE: Readonly<Record<SupervisorDelegateRoleId, string>> = {
  worker: "worker: one independently completable external observation/effect. Do not disguise coordinated outcomes as one task.",
  planner: "planner: When Planner is available and the remaining requested work requires multiple execution steps using at least two different tools, you MUST invoke Planner before delegating execution, even for a single final deliverable. This rule takes precedence over general role-selection guidance. Repeated calls to the same tool do not satisfy this condition. Choose Planner when the requested final state contains multiple coordinated persistent deliverables, effects, or components that must be managed together. Do not choose Planner merely because an answer has several parts or requires substantial reasoning. Planner owns project orientation and decomposition.",
  researcher: "researcher: understanding, comparison, analysis or research synthesis; the role delegates any required new external observation to Worker.",
  reviewer: "reviewer: independent assessment of supplied/delegated work. The runtime binds its target; supply no objective.",
};

export function buildSupervisorRoleGuidance(
  roles: readonly SupervisorDelegateRoleId[],
): readonly string[] {
  return roles.map((role) => ROLE_GUIDANCE[role]);
}

export function buildSupervisorDelegationGuidance(): readonly string[] {
  return [
    "Delegation",
    "Keep targets beneath the exact project root. A software project named NAME uses NAME/ unless the user requests another form. Delegate usable project artifacts, not source text or previews.",
    "objective contains only the remaining external end state, target, source facts and constraints. Children do not inherit conversation: resolve vague references into bounded concrete material and include dependencies absent from supplied settled sibling results. Never rediscover established sibling information.",
    "Do not prescribe reasoning, decomposition, operation order, capability, layout, framework or implementation left open by the user. Preserve essential task constraints explicitly requested by the user.",
    "Artifacts stay at their targets; request contents, listings, transcripts or separate proof only if the user asked. workingDirectory has a separate phase after role/objective selection.",
    "Delegation is not completion: do not also answer the user or claim execution.",
    "Keep objective very short. State the required outcome and only essential targets, facts and constraints, each once. Do not include reasoning, justification, repetition or the delegated role’s plan. Complete the JSON immediately afterward.",
  ];
}
