import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryLongTermMemoryRepository } from "../adapters/long-term-memory/in-memory-repository.js";
import { createLongTermMemoryService } from "../long-term-memory/service.js";
import { DEFAULT_MATURATION_POLICY } from "../long-term-memory/maturation/retention.js";
import { configureLearningMaturationPolicy } from "../long-term-memory/maturation/policy.js";
import type { PassiveLearningService } from "../passive-learning/contracts.js";
import { createPassiveLearningService } from "../passive-learning/service.js";
import { createLearningStateStore, DEFAULT_LEARNING_PREFERENCES, type LearningState } from "../passive-learning/store.js";

vi.mock("../passive-learning/store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../passive-learning/store.js")>()),
  createLearningStateStore: vi.fn(),
}));

const services: PassiveLearningService[] = [];
const stopRetention: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  for (const stop of stopRetention.splice(0)) await stop();
  vi.restoreAllMocks();
});

async function fixture() {
  const base = createInMemoryLongTermMemoryRepository();
  const update = vi.fn(base.update);
  const repository = { ...base, update };
  const embed = vi.fn();
  const memory = createLongTermMemoryService({ repository, embeddings: { embed }, enabled: true, emitClientEvents: false });
  if (memory.retention) stopRetention.push(() => memory.retention!.stop());
  await memory.learning!.configurePolicy(DEFAULT_MATURATION_POLICY);
  let persisted: LearningState = { schemaVersion: 1, preferences: DEFAULT_LEARNING_PREFERENCES, batches: [] };
  const write = vi.fn(async (state: LearningState) => { persisted = state; });
  vi.mocked(createLearningStateStore).mockReturnValue({ read: async () => persisted, write });
  const service = createPassiveLearningService({ directory: "mock-policy-store", ownerId: "test", memory,
    model: { validateProfile: vi.fn(), extract: vi.fn() } });
  services.push(service);
  await service.start();
  update.mockClear();
  write.mockClear();
  return { service, memory, repository, update, write, embed, persisted: () => persisted };
}

describe("canonical maturation policy persistence", () => {
  it.each([false, true])("resolves a concurrent policy change under the repository transaction (initializeOnly=%s)", async (initializeOnly) => {
    const base = createInMemoryLongTermMemoryRepository();
    const original = DEFAULT_MATURATION_POLICY;
    const concurrent = { ...original, promotionScore: 98 };
    await configureLearningMaturationPolicy(base, original);
    let pendingConcurrentWrite = true;
    const commitConcurrentPolicy = async () => {
      if (!pendingConcurrentWrite) return;
      pendingConcurrentWrite = false;
      await configureLearningMaturationPolicy(base, concurrent);
    };
    const repository = {
      async read() {
        const stale = await base.read();
        await commitConcurrentPolicy();
        return stale;
      },
      async update(mutate: Parameters<typeof base.update>[0]) {
        await commitConcurrentPolicy();
        return base.update(mutate);
      },
    };
    const result = await configureLearningMaturationPolicy(repository, original, initializeOnly);
    const expected = initializeOnly ? concurrent : original;
    expect(result).toEqual(expected);
    expect((await base.read()).maturationPolicy).toEqual(expected);
  });

  it("keeps the admission policy unchanged when the preferences journal cannot save", async () => {
    const f = await fixture();
    const before = await f.repository.read();
    f.write.mockRejectedValueOnce(new Error("disk full"));
    const requested = { ...DEFAULT_MATURATION_POLICY, promotionScore: 99, retentionDays: 1 };
    await expect(f.service.configure({ maturation: requested })).rejects.toThrow("learning_storage_unavailable");
    expect(await f.repository.read()).toEqual(before);
    expect(await f.memory.learning!.policy()).toEqual(DEFAULT_MATURATION_POLICY);
    expect((await f.service.status()).preferences.maturation).toEqual(DEFAULT_MATURATION_POLICY);
    expect(f.persisted().preferences).toEqual(DEFAULT_LEARNING_PREFERENCES);
    expect(f.embed).not.toHaveBeenCalled();
  });

  it("restores persisted preferences when the canonical policy write fails", async () => {
    const f = await fixture();
    f.update.mockRejectedValueOnce(new Error("policy_write_failed"));
    const requested = { ...DEFAULT_MATURATION_POLICY, promotionScore: 99 };
    await expect(f.service.configure({ maturation: requested })).rejects.toThrow("policy_write_failed");
    expect(f.write).toHaveBeenCalledTimes(2);
    expect(f.write.mock.calls[0]![0].preferences.maturation).toEqual(requested);
    expect(f.persisted().preferences.maturation).toEqual(DEFAULT_MATURATION_POLICY);
    expect(await f.memory.learning!.policy()).toEqual(DEFAULT_MATURATION_POLICY);
    expect((await f.service.status()).preferences.maturation).toEqual(DEFAULT_MATURATION_POLICY);
  });

  it("publishes canonical policy only after the journal has accepted the settings", async () => {
    const f = await fixture();
    const requested = { ...DEFAULT_MATURATION_POLICY, promotionScore: 97 };
    let admitWrite!: () => void;
    let signalWriting!: () => void;
    const writing = new Promise<void>((resolve) => { signalWriting = resolve; });
    const save = f.write.getMockImplementation()!;
    f.write.mockImplementationOnce(async (state) => {
      signalWriting();
      await new Promise<void>((resolve) => { admitWrite = resolve; });
      await save(state);
    });
    const pending = f.service.configure({ maturation: requested });
    await writing;
    expect(await f.memory.learning!.policy()).toEqual(DEFAULT_MATURATION_POLICY);
    admitWrite();
    await expect(pending).resolves.toMatchObject({ preferences: { maturation: requested } });
    expect(await f.memory.learning!.policy()).toEqual(requested);
    expect(f.persisted().preferences.maturation).toEqual(requested);
  });
});
