type RolePresentation = "execution_agent" | "auditor";

function executionPresentationRole(role: unknown): RolePresentation | undefined {
  if (role === "supervisor") return "execution_agent";
  if (role === "reviewer") return "auditor";
  return undefined;
}

/** Presentation only: the frozen contract never changes canonical role identity. */
export function projectRolePresentationEvent(
  rootContractId: string,
  name: string,
  payload?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (rootContractId !== "execution_agent") return payload;
  if (!payload) return payload;
  const canonicalRole = eventCanonicalRole(name, payload);
  const presentationRole = executionPresentationRole(canonicalRole);
  if (!presentationRole) return payload;
  return { ...payload, presentationRole };
}

function eventCanonicalRole(name: string, payload: Record<string, unknown>): unknown {
  if (name.startsWith("tool.")) return payload.executorRole;
  if (name === "runtime.state") return payload.stage;
  return undefined;
}
