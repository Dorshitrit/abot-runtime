import type { LongTermMemoryEmbeddingClient, LongTermMemoryRepository, MemoryVectorIndexEntry } from "../contracts.js";
import { embedLongTermMemoryTexts } from "../embedding-batches.js";
import { assertObservationBatchReplayable } from "../observation-receipt-retention.js";
import type { ApplyLearningDecisionsInput, LearningMemoryReceipt, LearningMemoryService } from "./contracts.js";
import { prepareLearningKnowledge } from "./context.js";
import { assertCurrentLearningDecisionBindings } from "./current-bindings.js";
import { normalizeLearningDecisions } from "./decisions.js";
import { currentLearningEmbeddingBinding } from "./embedding-binding.js";
import { commitLearningDecisions } from "./transition.js";
import { isCandidateUnexpired, normalizeMaturationPolicy } from "./retention.js";
import { reserveLearningEmbeddings } from "./embedding-reservation.js";
import { learningKnowledgeOverview } from "./overview.js";
import { maintainLearningMemory, nextLearningExpiryAt } from "./maintenance.js";
import { nextKnowledgeReconsiderationAt, scheduledKnowledgeContext } from "./scheduled-review.js";
import { assertLearningReviewAdmitted, learningReviewAdmission } from "./receipt-capacity.js";
import { configureLearningMaturationPolicy, learningMaturationPolicy } from "./policy.js";
import { createLearningApplyDiagnostics } from "./apply-diagnostics.js";

export function createLearningMemoryService(options: {
  repository: LongTermMemoryRepository;
  embeddings: LongTermMemoryEmbeddingClient;
  now?: () => Date;
}): LearningMemoryService {
  const now = () => (options.now ?? (() => new Date()))().getTime();
  return Object.freeze({
    async policy() { return learningMaturationPolicy(await options.repository.read()); },
    configurePolicy: (policy, initializeOnly) => configureLearningMaturationPolicy(options.repository, policy, initializeOnly),
    async reviewAdmission() { return learningReviewAdmission((await options.repository.read()).learningReceipts ?? [], now()); },
    async nextReconsiderationAt(input) { return nextKnowledgeReconsiderationAt(await options.repository.read(), now(), input); },
    async reconsiderationContext(input) { return scheduledKnowledgeContext(await options.repository.read(), now(), input); },
    async maintenance(policy) {
      const snapshot = await options.repository.read();
      return maintainLearningMemory(options.repository, normalizeMaturationPolicy(snapshot.maturationPolicy ?? policy), now());
    },
    async nextExpiryAt(policy) {
      const snapshot = await options.repository.read();
      return nextLearningExpiryAt(snapshot, normalizeMaturationPolicy(snapshot.maturationPolicy ?? policy));
    },
    async overview() { return learningKnowledgeOverview(await options.repository.read(), now()); },
    async sourceVersions() {
      const snapshot = await options.repository.read();
      return [
        ...(snapshot.learningCandidates ?? []).filter((record) => isCandidateUnexpired(record, now())).map((record) => ({ kind: "candidate" as const, id: record.id, version: String(record.revision) })),
        ...snapshot.records.map((record) => ({ kind: "memory" as const, id: record.id, version: record.updatedAt })),
      ];
    },
    prepare: (input) => prepareLearningKnowledge({ ...options, ...input, now: now(), embeddings: reserveLearningEmbeddings(options.embeddings, input.beforeEmbedding) }),
    async list() {
      const snapshot = await options.repository.read();
      return (snapshot.learningCandidates ?? []).filter((record) => isCandidateUnexpired(record, now()));
    },
    async receipt(batchId) {
      return (await options.repository.read()).learningReceipts?.find((receipt) => receipt.batchId === batchId);
    },
    async apply(rawInput) {
      const diagnostics = createLearningApplyDiagnostics(rawInput);
      try {
        const decisions = normalizeLearningDecisions(rawInput.decisions);
        rawInput.abortSignal.throwIfAborted();
        assertObservationBatchReplayable(rawInput, now());
        diagnostics.enter("admission");
        const initial = await options.repository.read();
        const input = { ...rawInput, policy: normalizeMaturationPolicy(initial.maturationPolicy ?? rawInput.policy), decisions };
        input.abortSignal.throwIfAborted();
        const previous = initial.learningReceipts?.find((receipt) => receipt.batchId === input.batchId);
        if (previous) {
          diagnostics.completed(previous, true);
          return previous;
        }
        assertLearningReviewAdmitted(initial.learningReceipts ?? [], now());
        diagnostics.enter("binding");
        assertCurrentLearningDecisionBindings(initial, input, now());
        const binding = currentLearningEmbeddingBinding(initial, now());
        diagnostics.enter("embedding");
        const vectors = await prepareDecisionEmbeddings(reserveLearningEmbeddings(options.embeddings, input.beforeEmbedding), input, binding);
        diagnostics.embedded(vectors.size);
        diagnostics.enter("commit");
        let receipt: LearningMemoryReceipt | undefined;
        let receiptReused = false;
        await options.repository.update((current) => {
          input.abortSignal.throwIfAborted();
          assertObservationBatchReplayable(input, now());
          receiptReused = Boolean(current.learningReceipts?.some((entry) => entry.batchId === input.batchId));
          const result = commitLearningDecisions({ current,
            input: { ...input, policy: normalizeMaturationPolicy(current.maturationPolicy ?? input.policy) },
            embeddings: vectors, now: now() });
          receipt = result.receipt;
          return result.state;
        });
        diagnostics.completed(receipt!, receiptReused);
        return receipt!;
      } catch (error) {
        diagnostics.failed(error);
        throw error;
      }
    },
  });
}

async function prepareDecisionEmbeddings(embeddings: LongTermMemoryEmbeddingClient, input: ApplyLearningDecisionsInput, expectedBinding: Pick<MemoryVectorIndexEntry, "modelFingerprint" | "dimensions"> | undefined): Promise<ReadonlyMap<string, Omit<MemoryVectorIndexEntry, "memoryId">>> {
  const changed = input.decisions.filter((decision) => {
    if (decision.action === "remove") return false;
    const target = input.context.entries.find((entry) => entry.kind === decision.targetKind && entry.id === decision.targetId);
    return !target || target.content !== decision.content;
  });
  const texts = [...new Set(changed.map(({ content }) => content))];
  if (!texts.length) return new Map();
  const result = await embedLongTermMemoryTexts({ embeddings, texts, abortSignal: input.abortSignal, debugRequestId: `learning:${input.batchId}`, ...(expectedBinding ? { expectedBinding } : {}) });
  return new Map(texts.map((content, index) => [content, { modelFingerprint: result.modelFingerprint, dimensions: result.dimensions, vector: result.vectors[index]! }]));
}
