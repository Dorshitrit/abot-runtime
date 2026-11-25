export const AGENT_DRAFT_BACKUP_PREFIX = "$legacy-coordinator-backup:";

export function belongsToAgentDraft(key, environment, agentId) {
  if (!agentId || agentId === "abot") return false;
  const [entryEnvironment, scope] = JSON.parse(key);
  if (entryEnvironment !== environment) return false;
  if (!scope.startsWith(AGENT_DRAFT_BACKUP_PREFIX)) return scope === agentId || scope.startsWith(agentId + ":");
  const encodedScope = scope.slice(AGENT_DRAFT_BACKUP_PREFIX.length).split(":")[0];
  return encodedScope === encodeURIComponent(agentId) || encodedScope.startsWith(encodeURIComponent(agentId + ":"));
}
