import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileLongTermMemoryRepository } from "../adapters/long-term-memory/file-repository.js";
import { createLongTermMemoryService } from "../long-term-memory/service.js";
import { candidateKnowledge } from "../long-term-memory/maturation/context.js";
import { DEFAULT_MATURATION_POLICY } from "../long-term-memory/maturation/retention.js";

const directories: string[] = [];
const timestamp = "2026-09-26T10:00:00.000Z";
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("legacy candidates without source history", () => {
  it("preserves stored memories and candidates across v4 migration without inventing admission evidence", async () => {
    await mkdir(join(process.cwd(), ".codex/artifacts"), { recursive: true });
    const directory = await mkdtemp(join(process.cwd(), ".codex/artifacts/legacy-memory-compat-"));
    directories.push(directory);
    const path = join(directory, "memory.json");
    const stored = { id: "stored", content: "Prefers written summaries.", tags: [],
      provenance: { kind: "passive_response", sourceSessionId: "old-session", sourceRequestId: "old-request" },
      createdAt: timestamp, updatedAt: timestamp };
    const candidate = { id: "candidate", revision: 1, content: "Prefers concise explanations.", tags: [],
      score: 100, certainty: "inferred", reason: "Legacy proposal.", sources: [],
      createdAt: timestamp, updatedAt: timestamp, lastReinforcedAt: timestamp,
      expiresAt: "2026-10-26T10:00:00.000Z", reconsiderAt: null,
      embedding: { memoryId: "candidate", dimensions: 2, modelFingerprint: "fixture", vector: [1, 0] } };
    const original = JSON.stringify({ schemaVersion: 4, revision: 1, records: [stored], vectors: [],
      learningCandidates: [candidate], learningReceipts: [] });
    await writeFile(path, original);
    const repository = createFileLongTermMemoryRepository(directory);
    const embed = vi.fn();
    const memory = createLongTermMemoryService({ repository, embeddings: { embed }, enabled: true,
      emitClientEvents: false, now: () => new Date(timestamp) });

    expect((await memory.list()).items).toEqual([stored]);
    expect(await memory.learning!.list()).toEqual([candidate]);
    expect(await readFile(path, "utf8")).toBe(original);
    await memory.learning!.configurePolicy(DEFAULT_MATURATION_POLICY);
    const reopened = createFileLongTermMemoryRepository(directory);
    const migrated = await reopened.read();
    expect(migrated.schemaVersion).toBe(5);
    expect(migrated.records).toEqual([stored]);
    expect(migrated.learningCandidates).toEqual([candidate]);
    expect(await readFile(path + ".pre-v5.backup", "utf8")).toBe(original);
    expect(embed).not.toHaveBeenCalled();

    const bound = candidateKnowledge(migrated.learningCandidates![0]!);
    const review = { kind: "learning_knowledge_reference_v1" as const, authority: "passive_reference" as const,
      presenceEffect: "does_not_authorize_actions_or_add_user_intent" as const,
      repositoryRevision: migrated.revision, knowledgeRevision: migrated.knowledgeRevision ?? migrated.revision,
      entries: [bound], omitted: 0, referenceTime: timestamp };
    const receipt = await memory.learning!.apply({ batchId: "fresh-observation", batchExpiresAt: "2026-09-27T10:00:00.000Z",
      environmentId: "dev", observations: [{ id: "one", deviceId: "pc", timestamp }],
      abortSignal: new AbortController().signal, context: review, policy: DEFAULT_MATURATION_POLICY,
      decisions: [{ action: "update", targetKind: "candidate", targetId: bound.id, targetVersion: bound.version,
        content: candidate.content, tags: [], score: 100, reason: "Fresh evidence.", certainty: "inferred",
        reinforced: true, observationIds: ["one"], mergedCandidateIds: [], reconsiderAt: null }] });
    expect(receipt.recordIds).toEqual([]);
    expect(receipt.candidateIds).toEqual([candidate.id]);
    const current = await reopened.read();
    expect(current.records).toEqual([stored]);
    expect(current.learningCandidates![0]!.reinforcements).toHaveLength(1);
    expect(current.learningCandidates![0]!.sources).toHaveLength(1);
    expect(embed).not.toHaveBeenCalled();
  });
});
