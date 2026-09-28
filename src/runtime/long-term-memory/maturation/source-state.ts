import { parseObservationSource } from "../observation-state.js";
import type { LearningMemoryReplacement, LearningMemorySource, LearningReinforcement } from "./evidence-contracts.js";

export function parseLearningSources(value: unknown): readonly LearningMemorySource[] {
  if (!Array.isArray(value)) throw new Error("learning_candidate_sources_corrupt");
  return Object.freeze(value.map((raw) => {
    const source = object(raw);
    if (source.kind === "passive_observation") return parseObservationSource(source);
    if (source.kind !== "passive_response") throw new Error("learning_candidate_sources_corrupt");
    const certainty = source.certainty;
    if (certainty !== "observed" && certainty !== "inferred") throw new Error("learning_candidate_sources_corrupt");
    return Object.freeze({
      kind: "passive_response" as const,
      sourceSessionId: identifier(source.sourceSessionId), sourceRequestId: identifier(source.sourceRequestId),
      observedAt: timestamp(source.observedAt), evidenceDigest: digest(source.evidenceDigest),
      reason: text(source.reason), certainty,
    });
  }));
}

export function parseLearningReinforcements(value: unknown): readonly LearningReinforcement[] {
  if (!Array.isArray(value) || value.length > 3) throw new Error("learning_candidate_evidence_corrupt");
  const records = value.map((raw) => {
    const record = object(raw);
    return Object.freeze({ key: digest(record.key), observedAt: timestamp(record.observedAt) });
  });
  if (new Set(records.map(({ key }) => key)).size !== records.length) throw new Error("learning_candidate_evidence_corrupt");
  if (records.some((record, index) => index > 0 && Date.parse(record.observedAt) < Date.parse(records[index - 1]!.observedAt)))
    throw new Error("learning_candidate_evidence_corrupt");
  return Object.freeze(records);
}

export function parseLearningReplacement(value: unknown): LearningMemoryReplacement {
  const replacement = object(value);
  return Object.freeze({ id: text(replacement.id), version: timestamp(replacement.version) });
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("learning_candidate_sources_corrupt");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("learning_candidate_sources_corrupt");
  return value;
}
function identifier(value: unknown): string {
  const result = text(value);
  if (result.length > 256) throw new Error("learning_candidate_sources_corrupt");
  return result;
}
function digest(value: unknown): string {
  const result = text(value);
  if (!/^[a-f0-9]{64}$/u.test(result)) throw new Error("learning_candidate_evidence_corrupt");
  return result;
}
function timestamp(value: unknown): string {
  const result = text(value);
  if (!Number.isFinite(Date.parse(result))) throw new Error("learning_candidate_sources_corrupt");
  return result;
}
