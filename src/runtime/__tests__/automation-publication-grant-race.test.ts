import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { RuntimeConfig, ToolRegistry } from "../ports.js";
import { createFileSchedulerStore } from "../scheduler/file-store.js";
import { createSchedulerService } from "../scheduler/scheduler-service.js";
import { createAutomationPersistence } from "../automations/persistence.js";
import { createAutomationDraftManager } from "../automations/draft-management.js";
import { createAutomationGrantManager } from "../automations/permission-grants.js";
import { createAutomationPublicationService } from "../automations/publication.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "automation-publication-grant-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = createFileSchedulerStore(root);
  const scheduler = createSchedulerService({
    environmentId: "dev", store, tickIntervalMs: 1_000_000,
    executor: { sessionExists: async () => true, tryReserve: () => null, start: vi.fn() },
  });
  cleanups.push(() => scheduler.stop());
  await scheduler.start();
  const persistence = createAutomationPersistence(store);
  const drafts = createAutomationDraftManager({ persistence });
  const operation = { toolName: "fixture", operationId: "read", contractVersion: 1 };
  const tools = { listNormalInvocations: () => [{
    toolName: "fixture", definition: { requiredPermissionMode: "full_plus" },
    contract: { version: 1, operations: [{
      operationId: "read", summary: "Read", effect: "read_only", approval: "request_policy",
      input: { type: "object", properties: {}, required: [], additionalProperties: false },
    }] },
  }] } as unknown as ToolRegistry;
  const grants = createAutomationGrantManager({ persistence, environmentId: "dev",
    availableOperations: async () => [{ operation, requiredMode: "full_plus" }] });
  const publication = createAutomationPublicationService({
    config: { runtimeId: "dev" } as RuntimeConfig, drafts, grants, persistence,
    scheduler, tools, timeZone: "UTC",
  });
  const created = await drafts.create("Publication race");
  const draft = await drafts.update(created.automationId, created.revision, {
    kind: "add_node", parentSequenceId: created.definition.body.id, index: 0,
    nodeWithoutId: { kind: "tool", title: "Read", onFailure: "stop", operation, controls: {} },
  });
  await grants.replace({ automationId: draft.automationId, expectedGrantRevision: 0,
    mode: "full_plus", operations: [operation], actionId: "initial-grant" });
  return { store, scheduler, persistence, drafts, grants, publication, draft, operation };
}

test.each([false, true])("revocation during publication cannot partially commit an existing job=%s", async (existing) => {
  const f = await fixture();
  let draft = f.draft;
  if (existing) {
    await f.publication.publish(draft.automationId, draft.revision);
    draft = await f.drafts.update(draft.automationId, draft.revision, {
      kind: "update_definition", patch: { title: "Updated title" },
    });
  }
  const before = await f.store.read();
  const definitions = (await f.persistence.read()).definitions;
  const readJob = f.scheduler.getAutomationJob.bind(f.scheduler);
  vi.spyOn(f.scheduler, "getAutomationJob").mockImplementationOnce(async (id) => {
    const job = await readJob(id);
    await f.grants.replace({ automationId: id, expectedGrantRevision: 1,
      mode: "full_access", operations: [], actionId: "revoke-before-commit" });
    return job;
  });
  await expect(f.publication.publish(draft.automationId, draft.revision))
    .rejects.toThrow("automation_grant_revision_conflict");
  expect((await f.store.read()).jobs).toEqual(before.jobs);
  expect((await f.persistence.read()).definitions).toEqual(definitions);
  expect((await f.grants.get(draft.automationId))?.grantRevision).toBe(2);
});

test("an unchanged captured grant publishes the definition and paused job together", async () => {
  const f = await fixture();
  const published = await f.publication.publish(f.draft.automationId, f.draft.revision);
  expect(published.job.state).toBe("paused");
  expect((await f.persistence.read()).definitions).toEqual([published.definition]);
  expect(await f.scheduler.getAutomationJob(f.draft.automationId)).toEqual(published.job);
});
