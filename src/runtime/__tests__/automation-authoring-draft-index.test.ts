import { afterEach, describe, expect, it } from "vitest";
import { createAutomationDraftToolModule } from "../capabilities/automations/tool-module.js";
import { createDefaultToolRegistry } from "../default-environment-adapters.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";

type Fixture = Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>;
type DraftIndex = {
  kind: string;
  grantsPermissions: boolean;
  drafts: { automationId: string; title: string; revision: number; status: string }[];
  nextOffset: number | null;
  omittedCount: number;
};

const fixtures: Fixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

function authoringModule(fixture: Fixture) {
  const service = fixture.application.services.automations!;
  return createAutomationDraftToolModule(() => service, async () => undefined);
}

async function invoke(module: ReturnType<typeof authoringModule>, params: Record<string, unknown>) {
  const result = await module.implementation(params);
  expect(result.ok).toBe(true);
  return { value: JSON.parse(result.output) as Record<string, unknown>,
    mutationEvidence: result.data?.mutationEvidence };
}

describe("automation draft authoring continuity", () => {
  it("lists exact existing IDs read-only, then edits only the explicitly selected draft", async () => {
    const fixture = await createSchedulerRuntimeFixture("execution-agent-v1");
    fixtures.push(fixture);
    const module = authoringModule(fixture);
    const first = (await invoke(module, { action: "create_draft", title: "Same title" })).value;
    const second = (await invoke(module, { action: "create_draft", title: "Same title" })).value;
    const firstId = String(first.automationId);
    const secondId = String(second.automationId);
    const service = fixture.application.services.automations!;
    const before = await service.list();

    const listed = await invoke(module, { action: "list_drafts" });
    const index = listed.value as DraftIndex;
    expect(index).toEqual({
      kind: "automation_draft_index_v1", grantsPermissions: false,
      drafts: [firstId, secondId].sort().map((automationId) => ({
        automationId, title: "Same title", revision: 1, status: "draft",
      })),
      nextOffset: null, omittedCount: 0,
    });
    expect(listed.mutationEvidence).toBe(false);
    expect(await service.list()).toEqual(before);
    expect(await service.getGrant(firstId)).toBeNull();
    expect(await service.getGrant(secondId)).toBeNull();

    const read = (await invoke(module, { action: "read_draft", automationId: firstId })).value;
    expect((read.draft as { revision: number }).revision).toBe(1);
    const edited = (await invoke(module, { action: "set_details", automationId: firstId,
      expectedRevision: 1, objective: "Updated only this draft" })).value;
    expect(edited.revision).toBe(2);
    expect((await service.getDraft(firstId))?.definition.objective).toBe("Updated only this draft");
    expect((await service.getDraft(secondId))?.revision).toBe(1);
    expect((await service.getDraft(secondId))?.definition.objective).toBe("");
    const after = (await invoke(module, { action: "list_drafts", offset: 0 })).value as DraftIndex;
    expect(after.drafts.find((draft) => draft.automationId === firstId)?.revision).toBe(2);
    expect(after.drafts.find((draft) => draft.automationId === secondId)?.revision).toBe(1);
    expect(fixture.invoke).not.toHaveBeenCalled();
    expect(fixture.invokeRaw).not.toHaveBeenCalled();
  });

  it("pages a fixed 50 summaries without definitions, run IDs or hidden overflow", async () => {
    const fixture = await createSchedulerRuntimeFixture("execution-agent-v1");
    fixtures.push(fixture);
    const service = fixture.application.services.automations!;
    const module = authoringModule(fixture);
    for (let number = 0; number < 51; number += 1)
      await service.create(`Draft ${String(number).padStart(2, "0")}`);

    const first = (await invoke(module, { action: "list_drafts" })).value as DraftIndex;
    expect(first.drafts).toHaveLength(50);
    expect(first.drafts[0]).toMatchObject({ title: "Draft 00", revision: 1, status: "draft" });
    expect(first.drafts[49]).toMatchObject({ title: "Draft 49", revision: 1, status: "draft" });
    expect(first.nextOffset).toBe(50);
    expect(first.omittedCount).toBe(1);
    for (const draft of first.drafts)
      expect(Object.keys(draft).sort()).toEqual(["automationId", "revision", "status", "title"]);

    const last = (await invoke(module, { action: "list_drafts", offset: first.nextOffset })).value as DraftIndex;
    expect(last.drafts).toHaveLength(1);
    expect(last.drafts[0]?.title).toBe("Draft 50");
    expect(last.nextOffset).toBeNull();
    expect(last.omittedCount).toBe(0);
    const beyond = (await invoke(module, { action: "list_drafts", offset: 99 })).value as DraftIndex;
    expect(beyond.drafts).toEqual([]);
    expect(beyond.nextOffset).toBeNull();
    expect(beyond.omittedCount).toBe(0);
    for (const offset of [-1, 1.5, null, "50", 2_147_483_648]) {
      const invalid = await module.implementation({ action: "list_drafts", offset });
      expect(invalid.ok).toBe(false);
      expect(invalid.error).toContain("automation_offset_invalid");
    }
    expect(fixture.invoke).not.toHaveBeenCalled();
  });

  it("exposes one read-only list operation in the default registry", async () => {
    const fixture = await createSchedulerRuntimeFixture("execution-agent-v1");
    fixtures.push(fixture);
    const service = fixture.application.services.automations!;
    const registry = createDefaultToolRegistry(fixture.config, undefined, {
      getService: () => service, ready: async () => undefined,
    });
    const operations = registry.listNormalInvocations?.().find((item) =>
      item.toolName === "automations")?.contract.operations ?? [];
    expect(operations.length).toBeLessThanOrEqual(32);
    expect(operations.find((item) => item.operationId === "list_drafts")).toMatchObject({
      effect: "read_only", input: {
        required: ["offset"], properties: { offset: { type: "integer", minimum: 0 } },
      },
    });
  });
});
