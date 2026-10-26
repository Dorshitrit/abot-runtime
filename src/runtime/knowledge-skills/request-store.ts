import type { KnowledgeSkillStore } from "./store.js";

/** One request view governs metadata, direct reads and tool reads alike. */
export function bindKnowledgeSkillsToRequest<T extends KnowledgeSkillStore>(
  store: T,
  rootContractId: string | undefined,
): T {
  if (rootContractId === undefined) return store;
  const excluded = new Set(store.getRequestExcludedSkillIds?.(rootContractId) ?? []);
  if (excluded.size === 0) return store;
  const isSkillAvailable = (skillId: string) => !excluded.has(skillId);
  return Object.freeze({
    ...store,
    list: () => store.list().filter(({ skillId }) => isSkillAvailable(skillId)),
    read: (skillId: string) => isSkillAvailable(skillId) ? store.read(skillId) : undefined,
  });
}
