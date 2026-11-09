import type { LongTermMemoryRepository } from "../contracts.js";
import type { LearningCandidateRecord } from "../maturation/contracts.js";
import type { LongTermMemoryManagementService, MemoryCandidateActionInput, MemoryCandidatePromoteInput } from "./contracts.js";
import { LongTermMemoryManagementError } from "./errors.js";
import { normalizeMemoryId } from "./validation.js";

/** Explicit user decisions reuse manual memory persistence; automatic maturation is unchanged. */
export function createManagedCandidateActions(input: {
  repository: LongTermMemoryRepository;
  management: Pick<LongTermMemoryManagementService, "create" | "update">;
}) {
  return {
    async promoteCandidate(request: MemoryCandidatePromoteInput) {
      request.context.abortSignal.throwIfAborted();
      const target = readCandidateActionBinding(request);
      if (!isCandidateManagementSource(request.source))
        throw new LongTermMemoryManagementError("long_term_memory_management_input_invalid");
      const snapshot = await input.repository.read();
      const candidate = requireCurrentManagedCandidate(snapshot.learningCandidates ?? [], target);
      const draft = { content: candidate.content, tags: candidate.tags, supersedesCandidate: target, context: request.context };
      if (candidate.replacement) {
        return input.management.update({ ...draft, id: candidate.replacement.id, expectedUpdatedAt: candidate.replacement.version });
      }
      return input.management.create({ ...draft, source: request.source });
    },
    async deleteCandidate(request: MemoryCandidateActionInput) {
      const target = readCandidateActionBinding(request);
      await input.repository.update(current => {
        requireCurrentManagedCandidate(current.learningCandidates ?? [], target);
        return { learningCandidates: (current.learningCandidates ?? []).filter(candidate => candidate.id !== target.id),
          records: current.records, vectors: current.vectors };
      });
      return Object.freeze({ deleted: true });
    },
  };
}

function isCandidateManagementSource(value: unknown): boolean {
  if (value === "web_ui") return true;
  return value === "management_api";
}

function readCandidateActionBinding(input: MemoryCandidateActionInput): MemoryCandidateActionInput {
  const id = normalizeMemoryId(input?.id);
  if (!Number.isSafeInteger(input.revision) || input.revision < 1)
    throw new LongTermMemoryManagementError("long_term_memory_management_input_invalid", { memoryId: id });
  return { id, revision: input.revision };
}

function requireCurrentManagedCandidate(candidates: readonly LearningCandidateRecord[], target: MemoryCandidateActionInput): LearningCandidateRecord {
  const candidate = candidates.find(item => item.id === target.id);
  if (!candidate) throw new LongTermMemoryManagementError("long_term_memory_management_not_found", { memoryId: target.id });
  if (candidate.revision !== target.revision)
    throw new LongTermMemoryManagementError("long_term_memory_management_conflict", { memoryId: target.id });
  return candidate;
}
