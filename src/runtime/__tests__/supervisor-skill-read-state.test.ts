import { afterEach, beforeEach, expect, test } from "vitest";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { RoleSkillRead } from "../orchestration/role-calls/skill-read.js";
import { buildSupervisorSkillSelectionInput } from "../steps/supervisor-decision/skill-selection-input.js";
import {
  buildSupervisorSkillReadStateMessages, collectSuccessfulSkillReadIdentities,
  SUPERVISOR_SKILL_READ_STATE_KIND,
} from "../steps/supervisor-decision/skill-read-state.js";
import { CORE_SKILL_DOCUMENT, createCoreSkillContextFixture } from "./support/core-skill-read-context-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

const binding = { readId: "skill-read-1", callId: "call-1", invocationAttempt: 1, steeringVersion: 0 };
const successfulRead: RoleSkillRead = {
  ...binding, operation: "read_skills", selectors: [CORE_SKILL_DOCUMENT.name],
  result: { outcome: "completed", skills: [CORE_SKILL_DOCUMENT] },
};

test("derives captured successful identities, excluding LIST and failed READ outcomes", () => {
  const listed = { ...CORE_SKILL_DOCUMENT, skillId: "only-listed", name: "Listed only" };
  const reads: RoleSkillRead[] = [
    { ...binding, operation: "list_skills", selectors: [], result: { outcome: "completed", skills: [listed] } },
    { ...binding, operation: "read_skills", selectors: ["failed-id"],
      result: { outcome: "failed", errorCode: "knowledge_skill_not_found", skills: [] } },
    successfulRead,
  ];
  expect(collectSuccessfulSkillReadIdentities(reads)).toEqual([
    { skillId: CORE_SKILL_DOCUMENT.skillId, name: CORE_SKILL_DOCUMENT.name },
  ]);
  expect(buildSupervisorSkillReadStateMessages("request-1", collectSuccessfulSkillReadIdentities(reads.slice(0, 2))))
    .toEqual([]);
});

test("deduplicates canonical IDs using the latest captured name without merging equal names", () => {
  const reads: RoleSkillRead[] = [
    successfulRead,
    { ...binding, operation: "read_skills", selectors: ["another-id"],
      result: { outcome: "completed", skills: [{ ...CORE_SKILL_DOCUMENT, skillId: "another-id" }] } },
    { ...binding, operation: "read_skills", selectors: [CORE_SKILL_DOCUMENT.skillId],
      result: { outcome: "completed", skills: [{ ...CORE_SKILL_DOCUMENT, name: "Updated captured name", revision: 2 }] } },
  ];
  expect(collectSuccessfulSkillReadIdentities(reads)).toEqual([
    { skillId: "another-id", name: CORE_SKILL_DOCUMENT.name },
    { skillId: CORE_SKILL_DOCUMENT.skillId, name: "Updated captured name" },
  ]);
});

test("bounds identities and names, retains exact IDs, and reports omissions deterministically", () => {
  const identities = Array.from({ length: 40 }, (_, index) => ({
    skillId: `read-${index}`, name: `Name ${index} ${"n".repeat(200)}`,
  }));
  const messages = buildSupervisorSkillReadStateMessages("request-1", identities);
  expect(messages).toEqual(buildSupervisorSkillReadStateMessages("request-1", identities));
  expect(messages).toHaveLength(1);
  expect(messages[0]!.role).toBe("system");
  const state = JSON.parse(messages[0]!.content as string);
  expect(state).toMatchObject({
    kind: SUPERVISOR_SKILL_READ_STATE_KIND, authority: "canonical_runtime_state",
    source: "role_call_ledger.skillReads", requestId: "request-1", outcome: "completed",
    totalCount: 40, omittedCount: 8, entryOrder: "latest_successful_read_first",
    applicability: "current_request_skill_selection_only",
  });
  expect(state.skills).toHaveLength(32);
  expect(state.skills.map(({ skillId }: { skillId: string }) => skillId))
    .toEqual(identities.slice(-32).reverse().map(({ skillId }) => skillId));
  for (const entry of state.skills) {
    expect(entry.name).toHaveLength(160);
    expect(entry.nameTruncated).toBe(true);
    expect(Object.keys(entry).sort()).toEqual(["name", "nameTruncated", "skillId"]);
  }
});

test("selection excludes captured IDs and preserves the current prompt and document routing", async () => {
  const f = await createCoreSkillContextFixture();
  const before = buildSupervisorSkillSelectionInput(f.request, { skillReadHead: f.ledger.current() });
  await f.read();
  const head = f.ledger.current();
  const serializedHead = JSON.stringify(head);
  const after = buildSupervisorSkillSelectionInput(f.request, { skillReadHead: head });
  expect(after.eligibleSkillIds).not.toContain(CORE_SKILL_DOCUMENT.skillId);
  expect(after.context.messages.map(({ role }) => role)).toEqual(["system", "system", "user"]);
  expect(after.context.messages.filter(({ role }) => role === "user"))
    .toEqual(before.context.messages.filter(({ role }) => role === "user"));
  expect(after.context.messages.at(-1)!.content).toBe(f.request.prompt);
  const state = JSON.parse(after.context.messages[1]!.content as string);
  expect(state.skills).toEqual([
    { skillId: CORE_SKILL_DOCUMENT.skillId, name: CORE_SKILL_DOCUMENT.name, nameTruncated: false },
  ]);
  expect(state.omittedCount).toBe(0);
  const text = JSON.stringify(after.context.messages);
  expect(text).not.toContain(CORE_SKILL_DOCUMENT.content);
  expect(text).not.toContain(CORE_SKILL_DOCUMENT.description);
  expect(text).not.toContain("runtime_core_skill_read_v1");
  expect(after.context.budget.parts.referenceInputTokens).toBeGreaterThan(0);
  expect(after.context.budget.formatReserveTokens).toBeGreaterThan(0);
  const routingMessages = f.input().context.messages;
  const documentMessage = routingMessages.find(({ content }) =>
    typeof content === "string" && content.startsWith('{"kind":"runtime_core_skill_read_v1"'));
  expect(JSON.parse(documentMessage!.content as string).document).toEqual(CORE_SKILL_DOCUMENT);
  expect(JSON.stringify(routingMessages)).not.toContain(SUPERVISOR_SKILL_READ_STATE_KIND);
  expect(JSON.stringify(head)).toBe(serializedHead);
  const restored = buildSupervisorSkillSelectionInput(f.request, { skillReadHead: JSON.parse(serializedHead) });
  expect(restored.context.messages).toEqual(after.context.messages);
  expect(buildSupervisorSkillSelectionInput(f.request).context.messages).toEqual(before.context.messages);
});
