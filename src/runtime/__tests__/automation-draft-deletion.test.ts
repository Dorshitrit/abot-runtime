import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { SchedulerSnapshot } from "../scheduler/contracts.js";
import { createAutomationDraftManager } from "../automations/draft-management.js";
import type { AutomationPersistence } from "../automations/persistence.js";
import { emptyAutomationJournalState } from "../automations/storage-records.js";
import type { AutomationService } from "../automations/service.js";
import { AutomationRoutes } from "../../web-ui/local-runtime/automation-routes.js";
import { createAutomationRequests } from "../../web-ui/app/services/runtime-web-client/automations.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createAutomationsController } from "../../web-ui/app/controllers/automations-controller.js";

function persistenceFixture() {
  let state = emptyAutomationJournalState();
  let scheduler: SchedulerSnapshot = { schemaVersion: 1, jobs: [], runs: [] };
  const persistence: AutomationPersistence = {
    read: async () => structuredClone(state),
    update: async (mutate) => {
      const candidate = structuredClone(state);
      const result = mutate(candidate);
      state = candidate;
      return result;
    },
    updateWithScheduler: async (mutate) => {
      const automationCandidate = structuredClone(state);
      const schedulerCandidate = structuredClone(scheduler);
      const result = mutate(schedulerCandidate, automationCandidate);
      state = automationCandidate;
      scheduler = schedulerCandidate;
      return result;
    },
  };
  return { persistence, snapshot: () => structuredClone(state), scheduler };
}

function responseFixture() {
  let status = 0;
  let body: Record<string, unknown> = {};
  const response = {
    writeHead(code: number) { status = code; },
    end(value: string) { body = JSON.parse(value) as Record<string, unknown>; },
    setHeader() {},
  } as unknown as ServerResponse;
  return { response, snapshot: () => ({ status, body }) };
}

const request = {
  headers: { "content-type": "application/json", host: "127.0.0.1:5177" },
  socket: {},
} as unknown as IncomingMessage;

describe("ABot Studio draft deletion", () => {
  it("removes only the unpublished draft and its scoped grants", async () => {
    const fixture = persistenceFixture();
    const manager = createAutomationDraftManager({ persistence: fixture.persistence });
    const deleted = await manager.create("ABot Automation");
    const kept = await manager.create("Keep this automation");
    await fixture.persistence.update((state) => {
      for (const draft of [deleted, kept]) {
        state.grants.push({
          id: `grant:${draft.automationId}`, automationId: draft.automationId,
          environmentId: "dev", grantRevision: 1, mode: "full_access", operations: [],
          evidence: { kind: "authenticated_user_action", actionId: "test", at: "2026-01-01T00:00:00.000Z" },
        });
      }
    });

    await manager.deleteUnpublishedDraft(deleted.automationId, deleted.revision);

    expect(await manager.get(deleted.automationId)).toBeNull();
    expect(await manager.list()).toEqual([expect.objectContaining({ id: kept.automationId })]);
    expect(fixture.snapshot().grants.map((grant) => grant.automationId)).toEqual([kept.automationId]);
  });

  it("rejects a stale revision without deleting the newer draft", async () => {
    const fixture = persistenceFixture();
    const manager = createAutomationDraftManager({ persistence: fixture.persistence });
    const initial = await manager.create("ABot Automation");
    const changed = await manager.update(initial.automationId, initial.revision, {
      kind: "update_definition", patch: { title: "Edited draft" },
    });

    await expect(manager.deleteUnpublishedDraft(initial.automationId, initial.revision))
      .rejects.toThrow("automation_revision_conflict");
    expect(await manager.get(initial.automationId)).toEqual(changed);
  });

  it.each(["definition", "job"])("keeps a draft with a published %s", async (published) => {
    const fixture = persistenceFixture();
    const manager = createAutomationDraftManager({ persistence: fixture.persistence });
    const draft = await manager.create("Published automation");
    if (published === "definition") {
      await fixture.persistence.update((state) => {
        state.definitions.push({
          id: `definition:${draft.automationId}:1`, automationId: draft.automationId,
          revision: 1, definition: draft.definition,
          publishedAt: "2026-01-01T00:00:00.000Z",
        });
      });
    } else {
      fixture.scheduler.jobs.push({
        id: draft.automationId, environmentId: "dev",
        target: { kind: "automation", automationId: draft.automationId, definitionRevision: 1 },
        title: draft.definition.title, timeZone: "UTC", schedule: { kind: "manual" },
        state: "paused", createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z", nextRunAt: null, revision: 1,
      });
    }

    await expect(manager.deleteUnpublishedDraft(draft.automationId, draft.revision))
      .rejects.toThrow("automation_draft_published");
    expect(await manager.get(draft.automationId)).toEqual(draft);
  });
});

describe("ABot Studio draft HTTP route", () => {
  it("creates an ABot Automation draft by default", async () => {
    const create = vi.fn(async () => ({ automationId: "new-draft", revision: 1 }));
    const routes = new AutomationRoutes(() => ({
      start: async () => undefined,
      services: { automations: { create } as unknown as AutomationService },
    }));
    const result = responseFixture();
    await routes.handle({
      method: "POST", segments: ["automations"],
      url: new URL("http://127.0.0.1:5177/automations?environment=dev"),
      body: {}, environmentId: "dev", request, response: result.response,
    });

    expect(create).toHaveBeenCalledExactlyOnceWith("ABot Automation", undefined);
    expect(result.snapshot().status).toBe(201);
  });

  it("requires a revision and forwards a confirmed draft deletion", async () => {
    const deleteDraft = vi.fn(async () => undefined);
    const routes = new AutomationRoutes(() => ({
      start: async () => undefined,
      services: { automations: { deleteDraft } as unknown as AutomationService },
    }));
    const base = {
      method: "DELETE", segments: ["automations", "draft-one", "draft"],
      url: new URL("http://127.0.0.1:5177/automations/draft-one/draft?environment=dev"),
      environmentId: "dev", request,
    };
    const missingRevision = responseFixture();
    await routes.handle({ ...base, body: {}, response: missingRevision.response });
    expect(missingRevision.snapshot().status).toBe(428);
    expect(deleteDraft).not.toHaveBeenCalled();

    const accepted = responseFixture();
    await routes.handle({ ...base, body: { expectedRevision: 2 }, response: accepted.response });
    expect(deleteDraft).toHaveBeenCalledExactlyOnceWith("draft-one", 2);
    expect(accepted.snapshot()).toEqual({ status: 200, body: { ok: true } });
  });
});

describe("ABot Studio draft client", () => {
  it("sends the revision with a JSON delete request", async () => {
    const requestApi = vi.fn(async () => ({ ok: true }));
    const client = createAutomationRequests({
      requestApi, getEnvironmentId: () => "dev",
      getConfig: () => ({ backend: "runtime" }),
    });

    await client.deleteAutomationDraft("draft/one", 3, "dev");

    expect(requestApi).toHaveBeenCalledExactlyOnceWith(
      "/automations/draft%2Fone/draft?environment=dev",
      { method: "DELETE", body: JSON.stringify({ expectedRevision: 3 }) },
    );
  });

  it("keeps selection after a failed delete and returns to the list after success", async () => {
    let automations = [{ id: "draft-one", draftRevision: 2 }];
    let rejectDelete = true;
    const deleteAutomationDraft = vi.fn(async () => {
      if (rejectDelete) throw new Error("automation_revision_conflict");
      automations = [];
      return { ok: true };
    });
    const client = {
      supportsAutomations: () => true,
      listAutomations: vi.fn(async () => ({ automations })),
      getAutomationDraft: vi.fn(async () => ({
        draft: { automationId: "draft-one", revision: 2, definition: { title: "ABot Automation" } },
        publishedDefinition: null,
      })),
      getAutomationCatalog: vi.fn(async () => ({ operations: [] })),
      listAutomationRuns: vi.fn(async () => ({ runs: [] })),
      deleteAutomationDraft,
    };
    const controller = createAutomationsController({
      client, getEnvironmentId: () => "dev", render: () => {},
    });
    await controller.openRoute("draft-one");

    expect(await controller.deleteDraft()).toBe(false);
    expect(controller.snapshot().selectedAutomationId).toBe("draft-one");
    rejectDelete = false;
    expect(await controller.deleteDraft()).toBe(true);
    expect(deleteAutomationDraft).toHaveBeenLastCalledWith("draft-one", 2, "dev");
    expect(controller.snapshot().selectedAutomationId).toBe("");
    expect(controller.snapshot().automations).toEqual([]);
    expect(controller.snapshot().feedback).toBe("Draft deleted.");
  });
});
