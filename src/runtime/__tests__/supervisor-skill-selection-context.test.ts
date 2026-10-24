import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { KnowledgeSkillDocument, KnowledgeSkillMetadata } from "../knowledge-skills/store.js";
import type { RoleCallLedgerHead } from "../orchestration/role-calls/index.js";
import type { RoleSkillRead } from "../orchestration/role-calls/skill-read.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import type { RequestExecutionSeed } from "../request/contracts.js";
import { createRequestExecutionScope, type RequestExecutionScope } from "../request/execution-scope.js";
import { createRequestSteeringInbox } from "../request/request-steering.js";
import { buildSupervisorSkillSelectionInput } from "../steps/supervisor-decision/skill-selection-input.js";
import { parseSupervisorSkillSelectionOutput } from "../steps/supervisor-decision/skill-selection.js";
import { prepareSupervisorDecision } from "../steps/supervisor-decision/preparation.js";
import { createCoreSkillContextFixture } from "./support/core-skill-read-context-fixture.js";
import { semanticContractFixture } from "./support/semantic-compaction-contract-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

const candidate: KnowledgeSkillDocument = {
  skillId: "guidance-id", name: "Guidance", description: "Applies to the current task.",
  content: "PRIVATE_DOCUMENT_BODY",
};
const budgetError = "request_context_final_envelope_exceeds_window";

function selectionFixture(skills: readonly KnowledgeSkillMetadata[] = [candidate]) {
  const fixture = semanticContractFixture({ contextWindowTokens: 64_000 });
  const base = fixture.params.request as RequestExecutionScope;
  const list = vi.fn(() => skills);
  const read = vi.fn(() => undefined);
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => ({
    text: JSON.stringify({ decision: { action: "continue" } }), meta: {},
  }));
  const request = createRequestExecutionScope({
    seed: {
      ...base,
      runnerConfig: {
        ...base.runnerConfig,
        steps: { ...base.runnerConfig.steps, "supervisor.decision": { timeoutMs: 20_000 } },
      },
      modelGatewayClient: { invoke, invokeRaw: vi.fn() },
    },
    executionPolicy: base.executionPolicy,
    knowledgeSkillStore: { list, read },
    createWorkerCapabilities: () => base.workerCapabilities.provider,
  });
  return { request, list, read, invoke };
}

function replaceSelectionRequest(request: RequestExecutionScope, changes: Partial<RequestExecutionSeed>) {
  return createRequestExecutionScope({
    seed: { ...request, ...changes }, executionPolicy: request.executionPolicy,
    knowledgeSkillStore: request.knowledgeSkillStore,
    createWorkerCapabilities: () => request.workerCapabilities.provider,
  });
}

function withContextCapacity(request: RequestExecutionScope, contextWindowTokens: number) {
  return replaceSelectionRequest(request, {
    modelPolicy: {
      ...request.modelPolicy!,
      profiles: {
        ...request.modelPolicy!.profiles,
        "contract-model": { ...request.modelPolicy!.profiles!["contract-model"]!, contextWindowTokens },
      },
    },
  });
}

function prepareSelection(request: RequestExecutionScope, skillReadHead?: RoleCallLedgerHead) {
  return prepareSupervisorDecision(request, {
    diagnostic: { requestId: request.requestId, modelStep: "supervisor.decision", decisionPhase: "skill_selection" },
    includeAcknowledgement: false, includeTitle: false, allowSkillReads: true,
    skillSelectionWindow: request.supervisorSkillSelectionWindows.bind({
      rootCallId: skillReadHead?.state.rootCallId ?? "selection-context-root",
    }),
    ...(skillReadHead ? { skillReadHead } : {}),
  });
}

function withMeasuredTokens(request: RequestExecutionScope, inputTokens: number) {
  const countInputTokens = vi.fn<NonNullable<ModelGatewayClient["countInputTokens"]>>(async () => ({
    inputTokens, profileId: "contract-model", provider: "openai", model: "contract-test",
    contextWindowTokens: request.modelPolicy!.profiles!["contract-model"]!.contextWindowTokens!,
    source: "provider_input_token_count",
  }));
  return {
    countInputTokens,
    request: replaceSelectionRequest(request, {
      modelGatewayClient: { ...request.modelGatewayClient, countInputTokens },
    }),
  };
}

function candidateMetadata(input: ReturnType<typeof buildSupervisorSkillSelectionInput>) {
  const serialized = input.context.messages[0]!.content
    .split("\n").find((line) => line.startsWith('{"kind":"runtime_supervisor_skill_candidates_v1"'))!;
  return JSON.parse(serialized) as {
    kind: string; authority: string; omittedCount: number; skills: KnowledgeSkillMetadata[];
  };
}

function selectionEnum(input: ReturnType<typeof buildSupervisorSkillSelectionInput>): string[] {
  const schema = input.format.schema as {
    properties: { decision: { anyOf: Array<{ properties: { skillIds?: { items: { enum: string[] } } } }> } };
  };
  return schema.properties.decision.anyOf.find((variant) => variant.properties.skillIds)!
    .properties.skillIds!.items.enum;
}

function successfulRead(skill: KnowledgeSkillDocument, index: number): RoleSkillRead {
  return {
    readId: `read-${index}`, callId: "restored-root", invocationAttempt: index, steeringVersion: 0,
    operation: "read_skills", selectors: [skill.name],
    result: { outcome: "completed", skills: [skill] },
  };
}

test("one copied Store snapshot binds the visible catalog, schema and parser despite later Store mutations", () => {
  const original = { ...candidate };
  const skills = [original];
  const f = selectionFixture(skills);
  const input = buildSupervisorSkillSelectionInput(f.request);
  const captured = { skillId: candidate.skillId, name: candidate.name, description: candidate.description };
  original.skillId = "replacement-id";
  original.description = "Replacement applicability.";
  skills.push({ ...candidate, skillId: "newly-created-id" });

  expect(f.list).toHaveBeenCalledOnce();
  expect(candidateMetadata(input).skills).toEqual([captured]);
  expect(input.eligibleSkillIds).toEqual([candidate.skillId]);
  expect(Object.isFrozen(input.eligibleSkillIds)).toBe(true);
  expect(selectionEnum(input)).toEqual(input.eligibleSkillIds);
  expect(parseSupervisorSkillSelectionOutput(JSON.stringify({
    decision: { action: "read_skills", skillIds: [candidate.skillId] },
  }), input.eligibleSkillIds).ok).toBe(true);
  for (const skillId of ["replacement-id", "newly-created-id", candidate.name]) {
    expect(parseSupervisorSkillSelectionOutput(JSON.stringify({
      decision: { action: "read_skills", skillIds: [skillId] },
    }), input.eligibleSkillIds).ok).toBe(false);
  }
  expect(f.list).toHaveBeenCalledOnce();
  expect(f.read).not.toHaveBeenCalled();
});

test("selection displays complete applicability and every candidate beyond the old 80-character and 512-token bounds", () => {
  const skills = Array.from({ length: 24 }, (_, index) => ({
    skillId: `candidate-${index}-${"i".repeat(100)}`,
    name: `${"Name detail ".repeat(11)}${index}`,
    description: `${"Scope detail ".repeat(20)}Only when explicit trigger ${index} is present.`,
    content: `${candidate.content}-${index}`,
  }));
  const f = selectionFixture(skills);
  const request = replaceSelectionRequest(f.request, {
    prompt: "Evaluate this exact request.",
    historyMessages: [{
      id: "old-request", role: "user", content: "OLD_HISTORY_DO_NOT_REPLAY", createdAt: "2026-10-01T00:00:00.000Z",
    }],
  });
  const input = buildSupervisorSkillSelectionInput(request);
  const metadata = candidateMetadata(input);
  expect(metadata).toMatchObject({ authority: "reference_data", omittedCount: 0 });
  expect(metadata.skills).toEqual(skills.map(({ skillId, name, description }) => ({ skillId, name, description })));
  expect(input.eligibleSkillIds).toEqual(skills.map(({ skillId }) => skillId));
  expect(selectionEnum(input)).toEqual(input.eligibleSkillIds);
  expect(input.context.budget.parts.instructionInputTokens).toBeGreaterThan(512);
  expect(input.context.messages.map(({ role }) => role)).toEqual(["system", "user"]);
  expect(input.context.messages.filter(({ role }) => role === "user")).toEqual([
    { role: "user", content: request.prompt },
  ]);
  expect(JSON.stringify(input.context.messages)).not.toContain(candidate.content);
  expect(JSON.stringify(input.context.messages)).not.toContain("OLD_HISTORY_DO_NOT_REPLAY");
  expect(f.read).not.toHaveBeenCalled();
});

test("restored eligibility uses all canonical successful IDs, not bounded read receipts or stale LIST contents", async () => {
  const ledgerFixture = await createCoreSkillContextFixture();
  const readDocuments = Array.from({ length: 40 }, (_, index) => ({
    ...candidate, skillId: `already-read-${index}`, name: `Old full name ${index}`,
  }));
  const archived = { ...candidate, skillId: "archived-skill" };
  const reads: RoleSkillRead[] = [
    ...readDocuments.map(successfulRead),
    successfulRead({ ...readDocuments[0]!, name: "Renamed captured document" }, 41),
    {
      readId: "old-list", callId: "restored-root", invocationAttempt: 42, steeringVersion: 0,
      operation: "list_skills", selectors: [],
      result: { outcome: "completed", skills: [archived, ...readDocuments] },
    },
  ];
  const head: RoleCallLedgerHead = JSON.parse(JSON.stringify({
    ...ledgerFixture.ledger.current(),
    state: { ...ledgerFixture.ledger.current().state, skillReads: reads },
  }));
  const before = JSON.stringify(head);
  const f = selectionFixture([...readDocuments, candidate]);
  const input = buildSupervisorSkillSelectionInput(f.request, { skillReadHead: head });
  expect(input.eligibleSkillIds).toEqual([candidate.skillId]);
  expect(candidateMetadata(input).skills.map(({ skillId }) => skillId)).toEqual([candidate.skillId]);
  expect(selectionEnum(input)).toEqual([candidate.skillId]);
  const receipt = JSON.parse(input.context.messages[1]!.content);
  expect(receipt).toMatchObject({ totalCount: 40, omittedCount: 8 });
  expect(receipt.skills).toHaveLength(32);
  expect(receipt.skills.some(({ skillId }: { skillId: string }) => skillId === "already-read-1")).toBe(false);
  expect(parseSupervisorSkillSelectionOutput(JSON.stringify({
    decision: { action: "read_skills", skillIds: ["already-read-1"] },
  }), input.eligibleSkillIds).ok).toBe(false);
  expect(JSON.stringify(input.context.messages)).not.toContain(archived.skillId);
  expect(JSON.stringify(input.context.messages)).not.toContain(candidate.content);
  expect(JSON.stringify(head)).toBe(before);
  expect(f.list).toHaveBeenCalledOnce();
  expect(f.read).not.toHaveBeenCalled();
  expect(buildSupervisorSkillSelectionInput(f.request).eligibleSkillIds).toEqual([
    ...readDocuments.map(({ skillId }) => skillId), candidate.skillId,
  ]);
});

test("full catalog admission reserves its output schema and accepts the exact remaining estimated budget", async () => {
  const f = selectionFixture();
  const { budget } = buildSupervisorSkillSelectionInput(f.request).context;
  const exactCapacity = budget.estimatedInputTokens + budget.outputReserveTokens + budget.safetyReserveTokens;
  expect(budget.formatReserveTokens).toBeGreaterThan(0);
  await expect(prepareSelection(withContextCapacity(f.request, exactCapacity)))
    .resolves.toMatchObject({ selection: { action: "continue" } });
  expect(f.invoke).toHaveBeenCalledOnce();
  f.invoke.mockClear();
  await expect(prepareSelection(withContextCapacity(f.request, exactCapacity - 1)))
    .rejects.toThrow(budgetError);
  await expect(prepareSelection(withContextCapacity(
    f.request, exactCapacity - budget.formatReserveTokens,
  ))).rejects.toThrow(budgetError);
  expect(f.read).not.toHaveBeenCalled();
  expect(f.invoke).not.toHaveBeenCalled();
});

const expandedInputs: Array<{
  name: string; extend: (request: RequestExecutionScope) => RequestExecutionScope;
}> = [
  { name: "current request", extend: (request) => replaceSelectionRequest(request, { prompt: `${request.prompt} Additional required scope.` }) },
  { name: "attachment reserves", extend: (request) => replaceSelectionRequest(request, {
    attachments: [{ id: "image", kind: "image", mimeType: "image/png", storageRef: "attachments/image.png" }],
  }) },
  { name: "steering", extend: (request) => {
    const requestSteering = createRequestSteeringInbox({ requestId: request.requestId });
    requestSteering.append({ steerId: "update", text: "Apply this additional scope to the current request." });
    return replaceSelectionRequest(request, { requestSteering });
  } },
  { name: "calibrated instructions", extend: (request) => replaceSelectionRequest(request, {
    modelPolicy: {
      ...request.modelPolicy!,
      defaults: { ...request.modelPolicy!.defaults, steps: { "supervisor.decision": "supervisor.decision" } },
      profiles: {
        ...request.modelPolicy!.profiles,
        "contract-model": {
          ...request.modelPolicy!.profiles!["contract-model"]!,
          calibration: { "supervisor.decision": { instructions: ["Additional calibrated guidance."] } },
        },
      },
    },
  }) },
  { name: "configured step instructions", extend: (request) => replaceSelectionRequest(request, {
    runnerConfig: {
      ...request.runnerConfig, steps: {
        ...request.runnerConfig.steps,
        "supervisor.decision": {
          timeoutMs: 20_000,
          instructionBlocks: [{ ref: "selection.md", content: "Additional configured guidance.", contentHash: "fixture-hash" }],
        },
      },
    },
  }) },
];

test.each(expandedInputs)("complete-catalog admission accounts for $name before any model or document read", async ({ extend }) => {
  const f = selectionFixture();
  const { budget } = buildSupervisorSkillSelectionInput(f.request).context;
  const exactCapacity = budget.estimatedInputTokens + budget.outputReserveTokens + budget.safetyReserveTokens;
  const bounded = withContextCapacity(f.request, exactCapacity);
  await expect(prepareSelection(bounded)).resolves.toMatchObject({ selection: { action: "continue" } });
  expect(f.invoke).toHaveBeenCalledOnce();
  f.invoke.mockClear();
  await expect(prepareSelection(extend(bounded))).rejects.toThrow(budgetError);
  expect(f.read).not.toHaveBeenCalled();
  expect(f.invoke).not.toHaveBeenCalled();
});

test("complete-catalog admission accounts for successful-read state even when eligibility is unchanged", async () => {
  const f = selectionFixture();
  const ledgerFixture = await createCoreSkillContextFixture();
  await ledgerFixture.read([{ ...candidate, skillId: "previously-captured-id" }]);
  const { budget } = buildSupervisorSkillSelectionInput(f.request).context;
  const bounded = withContextCapacity(
    f.request, budget.estimatedInputTokens + budget.outputReserveTokens + budget.safetyReserveTokens,
  );
  await expect(prepareSelection(bounded)).resolves.toMatchObject({ selection: { action: "continue" } });
  expect(f.invoke).toHaveBeenCalledOnce();
  f.invoke.mockClear();
  await expect(prepareSelection(bounded, ledgerFixture.ledger.current())).rejects.toThrow(budgetError);
  expect(f.read).not.toHaveBeenCalled();
  expect(f.invoke).not.toHaveBeenCalled();
});

test("oversized complete catalogs fail before reads instead of exposing a partial candidate list", async () => {
  const skills = Array.from({ length: 200 }, (_, index) => ({
    skillId: `skill-${index}`, name: `Skill ${index}`, description: "Applicability detail ".repeat(24),
  }));
  const f = selectionFixture(skills);
  await expect(prepareSelection(withContextCapacity(f.request, 16_000))).rejects.toThrow(budgetError);
  expect(f.list).toHaveBeenCalledOnce();
  expect(f.read).not.toHaveBeenCalled();
  expect(f.invoke).not.toHaveBeenCalled();
});

test("provider measurement admits the complete catalog even when the local estimate exceeds capacity", async () => {
  const skills = Array.from({ length: 200 }, (_, index) => ({
    skillId: `skill-${index}`, name: `Skill ${index}`, description: "Applicability detail ".repeat(24),
  }));
  const f = selectionFixture(skills);
  const bounded = withContextCapacity(f.request, 16_000);
  const input = buildSupervisorSkillSelectionInput(bounded);
  expect(input.context.budget.estimatedInputTokens).toBeGreaterThan(input.context.budget.availableInputTokens);
  const measured = withMeasuredTokens(bounded, 12_000);
  f.list.mockClear();
  await expect(prepareSelection(measured.request)).resolves.toMatchObject({ selection: { action: "continue" } });
  expect(measured.countInputTokens).toHaveBeenCalledOnce();
  expect(f.invoke).toHaveBeenCalledOnce();
  const invocation = f.invoke.mock.calls[0]![0];
  expect(invocation.messages).toEqual(input.context.messages);
  expect(invocation.format).toEqual(input.format);
  expect(f.list).toHaveBeenCalledOnce();
  expect(f.read).not.toHaveBeenCalled();
});

test("provider measurement rejects the complete catalog before invocation even when the local estimate fits", async () => {
  const f = selectionFixture();
  const bounded = withContextCapacity(f.request, 16_000);
  const { budget } = buildSupervisorSkillSelectionInput(bounded).context;
  expect(budget.estimatedInputTokens).toBeLessThan(budget.availableInputTokens);
  const measured = withMeasuredTokens(bounded, 15_000);
  f.list.mockClear();
  await expect(prepareSelection(measured.request)).rejects.toThrow(budgetError);
  expect(measured.countInputTokens).toHaveBeenCalledOnce();
  expect(f.list).toHaveBeenCalledOnce();
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalled();
});
