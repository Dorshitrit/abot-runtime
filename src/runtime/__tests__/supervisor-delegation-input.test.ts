import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { RequestHistoryMessage } from "../context/request-context-contracts.js";
import type { RequestToolResultsView } from "../context/request-tool-results.js";
import { buildCoreSkillReadContextMessages, CORE_SKILL_READ_MESSAGE_KIND } from "../context/core-skill-read-context.js";
import { buildRequestTemporalContextMessage } from "../context/request-temporal-context.js";
import { SESSION_ARTIFACT_PATHS_MESSAGE_KIND } from "../context/session-artifact-paths.js";
import type { RequestSessionMemory } from "../context/session-memory/contracts.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { RequestExecutionSeed } from "../request/contracts.js";
import { buildSupervisorDelegationInput } from "../steps/supervisor-decision/delegation-input.js";
import { parseSupervisorDelegationOutput } from "../steps/supervisor-decision/delegation-contract.js";
import { CORE_SKILL_DOCUMENT, createCoreSkillContextFixture } from "./support/core-skill-read-context-fixture.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";
import {
  createProcedureOrchestrationFixture,
  PROCEDURE_OLD_HISTORY, PROCEDURE_PROMPT, PROCEDURE_SOURCE,
} from "./support/supervisor-procedure-orchestration-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { resetDebugLoggerConfig(); vi.restoreAllMocks(); });

const EMPTY_RESULTS: RequestToolResultsView = Object.freeze({ sourceRevision: 0, results: [] });
const INITIAL_MEMORY: ChatMessage = Object.freeze({
  role: "system", content: JSON.stringify({
    kind: "runtime_long_term_memory_reference_v1", authority: "passive_reference",
    memories: [{ content: "INITIAL_MEMORY_SENTINEL", tags: ["format"] }],
  }),
});
const TEMPORAL_CONTEXT = Object.freeze({ currentDateTime: "2026-10-20 22:00:00 GMT+03:00", timeZone: "Asia/Jerusalem" });

function fixture(overrides: Partial<RequestExecutionSeed> = {}) {
  const f = createProcedureOrchestrationFixture(() => ({ action: "respond" }), { skills: true });
  return { ...f, request: deriveTestRequestExecutionScope(f.request, overrides) };
}

test("delegation keeps the exact current request once and only the latest complete source turn", () => {
  const f = fixture();
  const input = buildSupervisorDelegationInput(f.request, { toolResults: EMPTY_RESULTS });
  expect(input.context.messages.slice(1)).toEqual([
    { role: "user", content: "Prepare the exact summary." },
    { role: "assistant", content: PROCEDURE_SOURCE },
    { role: "user", content: PROCEDURE_PROMPT },
  ]);
  expect(input.context.messages.filter(({ content }) => content === PROCEDURE_PROMPT)).toHaveLength(1);
  expect(input.context.selectedHistoryMessageIds).toEqual(["prior-user", "prior-assistant"]);
  expect(input.context.omittedHistoryMessageIds).toEqual(["old-user", "old-assistant"]);
  expect(JSON.stringify(input.context.messages)).not.toContain(PROCEDURE_OLD_HISTORY);
  expect(input.context.budget.parts.selectedHistoryInputTokens).toBeGreaterThan(0);
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.store.list).not.toHaveBeenCalled();
  expect(f.store.read).not.toHaveBeenCalled();
});

test("incomplete turns and tool observations cannot replace the latest complete conversation source", () => {
  const f = fixture();
  const extra: readonly RequestHistoryMessage[] = [
    { id: "unmatched-assistant", role: "assistant", content: "UNMATCHED_SENTINEL", requestId: "missing", createdAt: "2026-10-20T10:00:00Z" },
    { id: "tool-observation", role: "assistant", grounding: "tool_observation", content: "TOOL_SENTINEL", createdAt: "2026-10-20T10:00:01Z" },
    { id: "incomplete-user", role: "user", content: "INCOMPLETE_SENTINEL", requestId: "unfinished", createdAt: "2026-10-20T10:00:02Z" },
  ];
  const request = deriveTestRequestExecutionScope(f.request, { historyMessages: [...f.request.historyMessages, ...extra] });
  const input = buildSupervisorDelegationInput(request, { toolResults: EMPTY_RESULTS });
  expect(input.context.selectedHistoryMessageIds).toEqual(["prior-user", "prior-assistant"]);
  expect(input.context.omittedHistoryMessageIds).toEqual(["old-user", "old-assistant", ...extra.map(({ id }) => id)]);
  expect(input.context.messages.filter(({ role }) => role === "assistant")).toEqual([{ role: "assistant", content: PROCEDURE_SOURCE }]);
});

test("an initial request without a complete prior turn adds no fabricated source", () => {
  const f = fixture({ historyMessages: [] });
  const input = buildSupervisorDelegationInput(f.request, { toolResults: EMPTY_RESULTS });
  expect(input.context.messages).toHaveLength(2);
  expect(input.context.messages[1]).toEqual({ role: "user", content: PROCEDURE_PROMPT });
  expect(input.context.selectedHistoryMessageIds).toEqual([]);
  expect(input.context.omittedHistoryMessageIds).toEqual([]);
});

test("delegation receives exact captured Skill capsules while capability catalogs remain outside", async () => {
  const f = await createCoreSkillContextFixture();
  await f.read();
  const head = f.ledger.current();
  const before = JSON.stringify(head.state);
  const input = buildSupervisorDelegationInput(f.request, {
    toolResults: EMPTY_RESULTS, skillReadHead: head,
    workerCapabilityAffordances: [{ purpose: "CAPABILITY_DESCRIPTION_SENTINEL", effect: "mutation" }],
    availableWorkerCapabilityCatalog: [{ groupId: "write", memberCount: 1, effects: ["mutation"] }],
  });
  const serialized = JSON.stringify(input.context.messages);
  const captured = input.context.messages.filter(({ content }) => {
    try { return JSON.parse(content).kind === CORE_SKILL_READ_MESSAGE_KIND; }
    catch { return false; }
  });
  expect(captured).toEqual(buildCoreSkillReadContextMessages(head));
  expect(captured).toHaveLength(1);
  expect(captured[0]!.role).toBe("user");
  expect(JSON.parse(captured[0]!.content)).toMatchObject({
    authority: "passive_reference", purpose: "skill_guidance",
    requestId: f.request.requestId,
    read: { operation: "read_skills", selectors: [CORE_SKILL_DOCUMENT.skillId] },
    document: CORE_SKILL_DOCUMENT,
  });
  expect(input.context.budget.parts.referenceInputTokens).toBeGreaterThan(0);
  expect(serialized).not.toContain("CAPABILITY_DESCRIPTION_SENTINEL");
  expect(serialized).not.toContain("runtime_execution_capability_catalog_v1");
  expect(input.workerCapabilityAffordances).toEqual([]);
  expect(input.availableWorkerCapabilityCatalog).toEqual([]);
  expect(JSON.stringify(input.format)).not.toContain("workerCapabilityScope");
  expect(f.ledger.current()).toBe(head);
  expect(JSON.stringify(head.state)).toBe(before);
});

test("initial memory, request time and attachments retain their exact phase-local representation", () => {
  const attachment = { id: "image-1", kind: "image" as const, mimeType: "image/png", storageRef: "attachments/image-1.png", data: "aW1hZ2U=" };
  const f = fixture({ temporalContext: TEMPORAL_CONTEXT, attachments: [attachment] });
  const input = buildSupervisorDelegationInput(f.request, { toolResults: EMPTY_RESULTS, initialMemoryMessage: INITIAL_MEMORY });
  expect(input.context.messages).toContainEqual(INITIAL_MEMORY);
  expect(input.context.messages).toContainEqual(buildRequestTemporalContextMessage(TEMPORAL_CONTEXT));
  expect(input.context.messages.at(-1)).toEqual({ role: "user", content: PROCEDURE_PROMPT, attachments: [attachment] });
  expect(input.context.budget.parts.referenceInputTokens).toBeGreaterThan(0);
});

test("initial delegation permits offered root recall while excluding Skill authoring and presentation", () => {
  const f = fixture();
  const input = buildSupervisorDelegationInput(f.request, {
    toolResults: EMPTY_RESULTS, allowedRoleIds: ["worker", "reviewer", "planner", "worker"],
    allowMemoryRecall: true, allowSkillAuthoring: true, includeAcknowledgement: true, includeTitle: true,
  });
  expect(input).toMatchObject({
    modelStep: "supervisor.decision", delegationOnly: true, allowedRoleIds: ["worker", "planner"],
    allowMemoryRecall: true, allowSkillAuthoring: false,
    includeAcknowledgement: false, includeTitle: false, includeResponseRecommendation: false,
  });
  const recall = { action: "recall_memory", query: "Previous user preferences" };
  expect(parseSupervisorDelegationOutput(JSON.stringify({ decision: recall }), input)).toEqual({ ok: true, decision: recall });
  expect(parseSupervisorDelegationOutput('{"decision":{"action":"author_skill"}}', input).ok).toBe(false);
  expect(JSON.stringify(input.format.schema)).not.toContain('"author_skill"');
  expect(JSON.stringify(input.format.schema)).toContain('"recall_memory"');
  const defaultInput = buildSupervisorDelegationInput(f.request, { toolResults: EMPTY_RESULTS });
  expect(defaultInput.allowMemoryRecall).toBe(false);
  expect(defaultInput.allowSkillAuthoring).toBe(false);
  expect(parseSupervisorDelegationOutput('{"decision":{"action":"author_skill"}}', defaultInput).ok).toBe(false);
});

test("an explicit new target stays current intent while prior paths remain passive references", () => {
  const prompt = "  Save the summary in new-target/report.txt.  ";
  const paths = ["prior/old-report.txt", "prior/other.txt"];
  const f = fixture({ prompt, sessionArtifactPaths: paths });
  const beforePaths = [...f.request.sessionArtifactPaths!];
  const input = buildSupervisorDelegationInput(f.request, { toolResults: EMPTY_RESULTS });
  expect(input.context.messages.at(-1)).toEqual({ role: "user", content: prompt });
  expect(input.context.messages.filter(({ content }) => content === prompt)).toHaveLength(1);
  const reference = input.artifactPathsProjection!.message;
  expect(reference.role).toBe("system");
  expect(JSON.parse(reference.content)).toMatchObject({
    kind: SESSION_ARTIFACT_PATHS_MESSAGE_KIND, targets: paths,
    authority: "canonical_runtime_state", purpose: "passive_tool_target_continuity_reference",
    nonAuthority: { addsUserIntent: false, addsPendingWork: false, choosesOrRedirectsTarget: false, provesCompletion: false },
  });
  expect(input.context.messages.filter(({ content }) => content === reference.content)).toHaveLength(1);
  expect(f.request.sessionArtifactPaths).toEqual(beforePaths);
  expect(input.context.messages.filter(({ role }) => role === "assistant")).toEqual([{ role: "assistant", content: PROCEDURE_SOURCE }]);
});

test("the raw last-turn projection neither consults session compaction nor mutates checkpoints", () => {
  const project = vi.fn<RequestSessionMemory["project"]>(() => { throw new Error("session_projection_must_not_run"); });
  const prepare = vi.fn<RequestSessionMemory["prepare"]>(async () => { throw new Error("session_compaction_must_not_run"); });
  const snapshot = vi.fn<NonNullable<RequestSessionMemory["snapshot"]>>(() => { throw new Error("session_snapshot_must_not_run"); });
  const f = fixture({ sessionMemory: { project, prepare, snapshot } });
  const historyBefore = JSON.stringify(f.request.historyMessages);
  const compactionBefore = f.request.contextCompactionStore!.snapshot!();
  const input = buildSupervisorDelegationInput(f.request, { toolResults: EMPTY_RESULTS });
  expect(input.context.selectedHistoryMessageIds).toEqual(["prior-user", "prior-assistant"]);
  expect(project).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
  expect(snapshot).not.toHaveBeenCalled();
  expect(JSON.stringify(f.request.historyMessages)).toBe(historyBefore);
  expect(f.request.contextCompactionStore!.snapshot!()).toEqual(compactionBefore);
  expect(input.context.compaction).toEqual({ applied: false, compactedSourceRefs: [] });
});

test("a long latest source stays exact even when its estimate exceeds the provider window", () => {
  const f = fixture();
  const source = "PREFIX\n" + "  טקסט 🙂 literal\\n  \n".repeat(2000) + "\nSUFFIX";
  const request = deriveTestRequestExecutionScope(f.request, {
    historyMessages: f.request.historyMessages.map((message) => message.id === "prior-assistant" ? { ...message, content: source } : message),
    modelPolicy: {
      ...f.request.modelPolicy!,
      profiles: { test: { ...f.request.modelPolicy!.profiles!.test!, contextWindowTokens: 4000 } },
    },
  });
  const input = buildSupervisorDelegationInput(request, { toolResults: EMPTY_RESULTS });
  expect(input.context.messages.filter(({ role }) => role === "assistant")).toEqual([{ role: "assistant", content: source }]);
  expect(input.context.selectedHistoryMessageIds).toEqual(["prior-user", "prior-assistant"]);
  expect(input.context.budget.estimatedInputTokens).toBeGreaterThan(input.context.budget.availableInputTokens);
  expect(input.context.compaction.applied).toBe(false);
  expect(f.invoke).not.toHaveBeenCalled();
});
