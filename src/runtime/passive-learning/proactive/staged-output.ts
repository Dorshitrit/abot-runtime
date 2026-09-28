import type { LearningKnowledgeEntry } from "../../long-term-memory/maturation/contracts.js";
import { isBoundedProactiveText } from "./contracts.js";
import type { StagedProactiveReferences } from "./staged-context.js";

function decodeStageObject(text: string, keys: readonly string[]): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error("proactive_output_invalid_json"); }
  if (!isStageOutputObject(value)) throw new Error("proactive_staged_output_invalid");
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error("proactive_staged_output_fields_invalid");
  return value;
}

function isStageOutputObject(value: unknown): value is Record<string, unknown> {
  if (!value) return false;
  if (typeof value !== "object") return false;
  return !Array.isArray(value);
}

export function decodeStagedProactiveSources(text: string, references: StagedProactiveReferences): readonly LearningKnowledgeEntry[] {
  const { sourceRefs } = decodeStageObject(text, ["sourceRefs"]);
  if (!Array.isArray(sourceRefs)) throw new Error("proactive_sources_invalid");
  if (sourceRefs.length > 12) throw new Error("proactive_sources_invalid");
  const seen = new Set<string>();
  return Object.freeze(sourceRefs.map((ref: unknown) => {
    if (typeof ref !== "string") throw new Error("proactive_source_stale_or_unknown");
    const entry = references.get(ref);
    if (!entry) throw new Error("proactive_source_stale_or_unknown");
    if (seen.has(ref)) throw new Error("proactive_source_duplicate");
    seen.add(ref);
    return entry;
  }));
}

export function decodeStagedProactiveObjective(text: string): string | null {
  const { objective } = decodeStageObject(text, ["objective"]);
  if (objective === null) return null;
  if (!isBoundedProactiveText(objective, 1000)) throw new Error("proactive_objective_invalid");
  return objective;
}

export function decodeStagedProactiveMessage(text: string): Readonly<{ title: string; message: string }> {
  const value = decodeStageObject(text, ["title", "message"]);
  if (!isBoundedProactiveText(value.title, 160)) throw new Error("proactive_title_invalid");
  if (!isBoundedProactiveText(value.message, 4000)) throw new Error("proactive_message_invalid");
  return { title: value.title, message: value.message };
}

export function decodeStagedProactiveTiming(text: string, hasProposal: boolean, acceptedAt: string) {
  const fields = hasProposal ? ["expiresInMinutes", "reconsiderInMinutes"] : ["reconsiderInMinutes"];
  const value = decodeStageObject(text, fields);
  const completionTime = Date.parse(acceptedAt);
  if (!Number.isFinite(completionTime)) throw new Error("proactive_reference_time_invalid");
  const expiresAt = hasProposal ? afterCompletion(value.expiresInMinutes, completionTime) : null;
  const reconsiderAt = value.reconsiderInMinutes === null ? null : afterCompletion(value.reconsiderInMinutes, completionTime);
  return { expiresAt, reconsiderAt };
}

export function hasCurrentStagedProactiveTiming(timing: Readonly<{ expiresAt: string | null; reconsiderAt: string | null }>, now: number): boolean {
  if (timing.expiresAt !== null && Date.parse(timing.expiresAt) <= now) return false;
  if (timing.reconsiderAt !== null && Date.parse(timing.reconsiderAt) <= now) return false;
  return true;
}

function afterCompletion(value: unknown, now: number): string {
  if (typeof value !== "number") throw new Error("proactive_time_invalid");
  if (!Number.isSafeInteger(value)) throw new Error("proactive_time_invalid");
  if (value <= 0) throw new Error("proactive_time_not_future");
  if (value > 43_200) throw new Error("proactive_time_too_distant");
  return new Date(now + value * 60_000).toISOString();
}
