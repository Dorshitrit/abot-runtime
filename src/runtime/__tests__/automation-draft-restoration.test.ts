import { describe, expect, it } from "vitest";
import { createAutomationDraftManager } from "../automations/draft-management.js";
import { createEmptyAutomationDefinition, parseDraftMutation } from "../automations/draft-mutations.js";
import { parseAutomationDefinition } from "../automations/definition-input.js";
import type { AutomationPersistence } from "../automations/persistence.js";
import { emptyAutomationJournalState } from "../automations/storage-records.js";
import type { SchedulerAutomationJob, SchedulerSnapshot } from "../scheduler/contracts.js";
import { makeAutomationSchedulerRun } from "../scheduler/automation-run-records.js";

const automationId = "automation-one";
const at = "2026-09-30T10:00:00.000Z";
const command = { kind: "restore_published", publishedRevision: 2 };

function fixture() {
  let state = emptyAutomationJournalState();
  const published = parseAutomationDefinition({
    ...createEmptyAutomationDefinition(automationId, "Published workflow"), revision: 2,
    objective: "Preserve the complete published configuration", workingDirectory: "/workspace",
    trigger: { kind: "schedule", schedule: { kind: "daily", at: "09:00" } },
    inputs: { topic: "Original topic" }, body: { kind: "sequence", id: "root", children: [
      { kind: "tool", id: "read", title: "Read", onFailure: "stop",
        operation: { toolName: "reader", operationId: "read", contractVersion: 1 },
        controls: { path: { kind: "literal", value: "/workspace/input.txt" } } },
      { kind: "agent", id: "summarize", title: "Summarize", onFailure: "stop", modelProfileId: "local",
        agentMode: "fast", roleInstructions: "Be concise", prompt: "Summarize the supplied source",
        inputs: { source: { kind: "node_result", nodeId: "read", select: "text" } },
        tools: [], result: { kind: "text" } },
    ] },
  });
  const edited = parseAutomationDefinition({ ...published, revision: 3, title: "Accidental edit",
    body: { ...published.body, children: [...published.body.children].reverse() } });
  state.drafts.push({ id: `draft:${automationId}`, automationId, revision: 3,
    storageRevision: 41, definition: edited, updatedAt: at },
  { id: "draft:unrelated", automationId: "unrelated", revision: 1, updatedAt: at,
    definition: createEmptyAutomationDefinition("unrelated", "Keep unchanged") });
  state.definitions.push({ id: `definition:${automationId}:2`, automationId, revision: 2,
    definition: published, publishedAt: at, dependencyFingerprint: "published-dependencies" });
  state.grants.push({ id: "grant-one", automationId, environmentId: "dev", grantRevision: 8,
    mode: "full_access", operations: [{ toolName: "reader", operationId: "read", contractVersion: 1 }],
    evidence: { kind: "authenticated_user_action", actionId: "allow", at } });
  const job: SchedulerAutomationJob = { id: "job-one", environmentId: "dev",
    target: { kind: "automation", automationId, definitionRevision: 2 }, title: published.title,
    timeZone: "UTC", schedule: { kind: "daily", at: "09:00" }, state: "active",
    createdAt: at, updatedAt: at, revision: 6, nextRunAt: "2026-10-01T09:00:00.000Z" };
  let scheduler: SchedulerSnapshot = { schemaVersion: 1, jobs: [job],
    runs: [makeAutomationSchedulerRun(job, "run-one", at, "manual")] };
  let ordinaryWrites = 0, atomicWrites = 0;
  const persistence: AutomationPersistence = {
    read: async () => structuredClone(state),
    update: async (mutate) => {
      ordinaryWrites += 1;
      const candidate = structuredClone(state);
      const result = mutate(candidate);
      state = candidate;
      return result;
    },
    updateWithScheduler: async (mutate) => {
      atomicWrites += 1;
      const candidate = structuredClone(state), schedulerCandidate = structuredClone(scheduler);
      const result = mutate(schedulerCandidate, candidate);
      state = candidate;
      scheduler = schedulerCandidate;
      return result;
    },
  };
  const manager = createAutomationDraftManager({ persistence, now: () => Date.parse(at) + 60_000 });
  return { manager, persistence, published, snapshot: () => structuredClone({ state, scheduler }),
    writes: () => ({ ordinaryWrites, atomicWrites }) };
}

describe("restoring a published automation into a new draft", () => {
  it("copies the frozen publication as a new content/storage revision without changing execution state", async () => {
    const { manager, snapshot, published, writes } = fixture();
    const before = snapshot();
    const restored = await manager.update(automationId, 3, command);
    expect(restored).toMatchObject({ id: `draft:${automationId}`, automationId,
      revision: 4, storageRevision: 42, updatedAt: "2026-09-30T10:01:00.000Z" });
    expect(restored.definition).toEqual({ ...published, revision: 4 });
    expect(restored.definition.body).not.toBe(published.body);
    const after = snapshot();
    expect(after.scheduler).toEqual(before.scheduler);
    expect(after.state).toEqual({ ...before.state, drafts: [restored, before.state.drafts[1]] });
    expect(writes()).toEqual({ ordinaryWrites: 0, atomicWrites: 1 });
  });

  it("restores only the current scheduler publication, never the largest retained revision", async () => {
    const { manager, persistence, published, snapshot } = fixture();
    await persistence.update((state) => {
      state.definitions.push({ id: `definition:${automationId}:5`, automationId, revision: 5,
        definition: { ...published, revision: 5, title: "Retained other publication" }, publishedAt: at });
    });
    const before = snapshot();
    expect((await manager.update(automationId, 3, command)).definition).toEqual({ ...published, revision: 4 });
    expect(snapshot().state.definitions).toEqual(before.state.definitions);
  });

  it.each([0, -1, 2.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid expected revision %s without persisting", async (revision) => {
      const { manager, snapshot, writes } = fixture();
      const before = snapshot();
      await expect(manager.update(automationId, revision, command)).rejects.toThrow("automation_revision_conflict");
      expect(snapshot()).toEqual(before);
      expect(writes()).toEqual({ ordinaryWrites: 0, atomicWrites: 0 });
    });

  it.each([
    { kind: "restore_published" }, { kind: "restore_published", publishedRevision: "2" },
    { kind: "restore_published", publishedRevision: 0 }, { kind: "restore_published", publishedRevision: 1.5 },
    { kind: "restore_published", publishedRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...command, definition: {} }, { ...command, unexpected: true },
  ])("rejects malformed restore commands without entering a transaction", async (value) => {
    const { manager, snapshot, writes } = fixture();
    const before = snapshot();
    await expect(manager.update(automationId, 3, value)).rejects.toThrow("automation_graph_invalid");
    expect(snapshot()).toEqual(before);
    expect(writes()).toEqual({ ordinaryWrites: 0, atomicWrites: 0 });
  });

  it("checks the latest draft revision inside the transaction and preserves a newer edit", async () => {
    const { manager, persistence, snapshot } = fixture();
    const previouslyRead = await manager.get(automationId);
    await persistence.update((state) => {
      state.drafts[0] = { ...state.drafts[0]!, revision: 4,
        definition: { ...state.drafts[0]!.definition, revision: 4, title: "Concurrent change" } };
    });
    const before = snapshot();
    await expect(manager.update(automationId, previouslyRead!.revision, command)).rejects.toThrow("automation_revision_conflict");
    expect(snapshot()).toEqual(before);
  });

  it("checks the publication revision inside the transaction even if the requested old record remains", async () => {
    const { manager, persistence, snapshot } = fixture();
    await persistence.updateWithScheduler((scheduler) => {
      const job = scheduler.jobs[0] as SchedulerAutomationJob;
      job.target = { ...job.target, definitionRevision: 3 };
    });
    const before = snapshot();
    await expect(manager.update(automationId, 3, command)).rejects.toThrow("automation_revision_conflict");
    expect(snapshot()).toEqual(before);
  });

  it.each(["job", "definition", "draft", "archived"])("rejects unavailable %s without altering any record", async (missing) => {
    const { manager, persistence, snapshot } = fixture();
    await persistence.updateWithScheduler((scheduler, state) => {
      if (missing === "job") scheduler.jobs = [];
      if (missing === "definition") state.definitions = [];
      if (missing === "draft") state.drafts = state.drafts.slice(1);
      if (missing === "archived") state.drafts[0] = { ...state.drafts[0]!, archivedAt: at };
    });
    const before = snapshot();
    const code = missing === "draft" ? "automation_not_found" : missing === "archived" ? "automation_archived" : "automation_not_published";
    await expect(manager.update(automationId, 3, command)).rejects.toThrow(code);
    expect(snapshot()).toEqual(before);
  });

  it("uses the canonical definition parser before committing the restored draft", async () => {
    const { manager, persistence, snapshot } = fixture();
    await persistence.update((state) => {
      state.definitions[0] = { ...state.definitions[0]!,
        definition: { ...state.definitions[0]!.definition, title: "x".repeat(161) } };
    });
    const before = snapshot();
    await expect(manager.update(automationId, 3, command)).rejects.toThrow("automation_graph_invalid");
    expect(snapshot()).toEqual(before);
  });

  it("keeps restoration outside the pure graph mutation language", () => {
    expect(() => parseDraftMutation(command)).toThrow("automation_graph_invalid");
  });
});
