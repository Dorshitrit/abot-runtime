import { AGENT_DRAFT_BACKUP_PREFIX as BACKUP, belongsToAgentDraft } from "../../lib/agent-draft-scope.js";
import { coordinatorDraftScope } from "./legacy-coordinator-drafts.js";
const KEY = "abot-web.agentDrafts";
const empty = () => ({ text: "", pendingId: "", intent: "auto" });
export function createAgentDrafts(storage, { onConflict = () => {}, createBackupId = () => crypto.randomUUID() } = {}) {
  function readAll() {
    try { return JSON.parse(storage?.getItem(KEY) || "{}"); }
    catch { return {}; }
  }
  function resolve(all, environment, id) {
    try { return coordinatorDraftScope(all, environment, id); }
    catch (error) { onConflict(error); throw error; }
  }
  async function save(all) {
    if (!storage) throw new Error("Agent draft storage is unavailable.");
    await storage.setItem(KEY, JSON.stringify(all));
  }
  function recovered(environment, agentId) {
    return Object.entries(readAll()).flatMap(([key, value]) => {
      const [entryEnvironment, id] = JSON.parse(key);
      if (entryEnvironment !== environment || !id.startsWith(BACKUP)) return [];
      const scopeId = decodeURIComponent(id.slice(BACKUP.length).split(":")[0]);
      if (scopeId !== agentId && !scopeId.startsWith(`${agentId}:`)) return [];
      return [{ id, scopeId, value }];
    });
  }
  return {
    read(environment, id) { return resolve(readAll(), environment, id).value || empty(); },
    async write(environment, id, value) {
      const all = readAll(), { key, legacyKey } = resolve(all, environment, id);
      const next = { text: String(value.text || ""), pendingId: String(value.pendingId || ""), intent: value.intent ?? "auto", onboarding: String(value.onboarding || "") };
      if (!next.text && !next.pendingId && !next.onboarding) delete all[key];
      else all[key] = next;
      if (legacyKey) delete all[legacyKey];
      await save(all);
    },
    async removeAgent(environment, agentId) {
      if (!agentId || agentId === "abot") return;
      await storage?.refresh?.();
      const all = readAll();
      let changed = false;
      for (const key of Object.keys(all)) {
        if (!belongsToAgentDraft(key, environment, agentId)) continue;
        delete all[key];
        changed = true;
      }
      if (changed) await save(all);
    },
    recovered,
    async resolveConflict(collision, choice) {
      if (!["current", "legacy"].includes(choice)) throw new Error("Choose which saved draft to use.");
      const all = readAll();
      if (JSON.stringify(all[collision.key]) !== JSON.stringify(collision.current) || JSON.stringify(all[collision.legacyKey]) !== JSON.stringify(collision.legacy)) throw new Error("The saved drafts changed in another window. Reopen the conflict before choosing.");
      const chosen = choice === "current" ? collision.current : collision.legacy;
      const retained = choice === "current" ? collision.legacy : collision.current;
      const backupId = `${BACKUP}${encodeURIComponent(collision.id)}:${createBackupId()}`;
      all[JSON.stringify([collision.environment, backupId])] = retained;
      all[collision.key] = chosen; delete all[collision.legacyKey];
      await save(all);
    },
    async restoreRecovered(environment, backup) {
      const all = readAll(), backupKey = JSON.stringify([environment, backup.id]);
      if (!backup.id.startsWith(`${BACKUP}${encodeURIComponent(backup.scopeId)}:`)) throw new Error("This saved draft does not belong to that Agent scope.");
      if (JSON.stringify(all[backupKey]) !== JSON.stringify(backup.value)) throw new Error("This saved draft changed in another window. Reopen Saved drafts.");
      const { key, legacyKey, value } = resolve(all, environment, backup.scopeId);
      all[key] = all[backupKey];
      if (value) all[backupKey] = value;
      else delete all[backupKey];
      if (legacyKey) delete all[legacyKey];
      await save(all);
    },
  };
}
