import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { acceptCollectionConsent, requireCollectionConsent } from "../../computer-access/collection-consent.js";
import { createPassiveLearningService } from "../passive-learning/service.js";
import { createLearningStateStore, DEFAULT_LEARNING_PREFERENCES } from "../passive-learning/store.js";
import type { LongTermMemoryService } from "../long-term-memory/contracts.js";
import type { PassiveLearningConnection } from "../passive-learning/contracts.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const base = join(process.cwd(), ".codex/artifacts/windows-native-computer-access/consent-service-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "root-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "environment", "passive-learning");
  const now = Date.now();
  const preferences = { ...DEFAULT_LEARNING_PREFERENCES, enabled: true, modelProfileId: "model",
    activityPermissions: { collection: true, learning: false, proactive: false } };
  const store = createLearningStateStore(directory);
  await store.write({ schemaVersion: 1, preferences, batches: [{
    id: "pending-before-awareness", generation: "previous", status: "pending", createdAt: new Date(now).toISOString(), recordIds: [],
    observations: [{ id: "retained", deviceId: "previous-companion", sequence: 1, timestamp: new Date(now).toISOString(),
      source: { app: "editor", windowId: "window" }, content: "Retained work", kind: "view", extraction: "uia", coverage: "partial" }],
  }] });
  const close = vi.fn();
  const connect = vi.fn<PassiveLearningConnection>(async (input) => {
    requireCollectionConsent(root);
    input.onEvent({ type: "status", state: "partial", reason: "uia_application_coverage",
      deviceId: "native-device", ownerId: input.ownerId, leaseId: input.leaseId });
    return { close };
  });
  const extract = vi.fn(async () => []);
  const memory = { status: async () => ({ enabled: false, available: false }) } as unknown as LongTermMemoryService;
  const service = createPassiveLearningService({ directory, ownerId: "dev", memory,
    model: { validateProfile: vi.fn(), extract }, connect, now: () => now });
  cleanup.push(() => service.stop());
  await service.start();
  return { root, service, connect, close, extract, store };
}

test("an enabled installation waits for awareness without changing permissions or retained work; acknowledgment alone never starts it", async () => {
  const f = await fixture();
  const blocked = await f.service.status();
  const retained = await f.service.batches();
  const persisted = await f.store.read();
  expect(blocked).toMatchObject({ collectionState: "permission_required", collectionReason: "collection_consent_required",
    preferences: { enabled: true, activityPermissions: { collection: true, learning: false, proactive: false } } });
  expect(blocked.pendingObservations).toBe(1);
  await acceptCollectionConsent(f.root);
  vi.useFakeTimers();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(f.connect).toHaveBeenCalledOnce();
  expect(await f.store.read()).toEqual(persisted);
  expect(await f.service.batches()).toEqual(retained);
  const restarted = await f.service.restartCollection!();
  expect(restarted).toMatchObject({ collectionState: "partial", collectionReason: "uia_application_coverage" });
  expect(f.connect).toHaveBeenCalledTimes(2);
  expect(restarted.preferences).toEqual(blocked.preferences);
  expect(await f.service.batches()).toEqual(retained);
  expect(f.extract).not.toHaveBeenCalled();
  await f.service.stop();
  await f.service.start();
  expect(f.connect).toHaveBeenCalledTimes(3);
  expect((await f.service.status()).collectionState).toBe("partial");
  await f.service.configure({ activityPermissions: { collection: false, learning: false, proactive: false } });
  expect((await f.service.status()).preferences.enabled).toBe(false);
  expect(f.close).toHaveBeenCalledTimes(2);
}, 30_000);
