import type { AutomationService } from "../../automations/service.js";

const PAGE_SIZE = 50;

function isAutomationDraftIndexOffset(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return false;
  if (value < 0) return false;
  return value <= 2_147_483_647;
}

/** A small, passive index for recovering an exact draft ID before reading or editing it. */
export async function readAutomationDraftIndex(service: AutomationService, offset: unknown) {
  if (!isAutomationDraftIndexOffset(offset)) throw new Error("automation_offset_invalid");
  const listed = await service.list();
  const ordered = [...listed].sort((left, right) =>
    left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  const page = ordered.slice(offset, offset + PAGE_SIZE);
  const omittedCount = Math.max(0, ordered.length - offset - page.length);
  return {
    kind: "automation_draft_index_v1" as const,
    grantsPermissions: false as const,
    drafts: page.map(({ id, title, draftRevision, status }) => ({
      automationId: id, title, revision: draftRevision, status,
    })),
    nextOffset: omittedCount > 0 ? offset + page.length : null,
    omittedCount,
  };
}
