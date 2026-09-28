import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createRuntimeProactiveModel } from "../passive-learning/proactive/model.js";
import type { ProactiveReviewInput } from "../passive-learning/proactive/contracts.js";
import type { ModelGatewayClient, RuntimeConfig } from "../ports.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { CoWorkerReviewProgress, ReviewProgressPort } from "../passive-learning/review-progress.js";
import { projectOllamaFormat } from "../../model-gateway/structured-output/ollama-format.js";
import { projectOpenAIResponsesFormat } from "../../model-gateway/structured-output/openai-format.js";
import { STAGED_PROACTIVE_AUTHORING_FORMAT, STAGED_PROACTIVE_SELECTION_FORMAT, STAGED_PROACTIVE_OBJECTIVE_FORMAT,
  createStagedProactiveTimingFormat } from "../passive-learning/proactive/staged-format.js";
import { createRuntimeConfig, disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const SOURCES = { sourceRefs: ["k2"] };
const OBJECTIVE = { objective: "Offer a focused review of the possible project" };
const MESSAGE = { title: "A review idea", message: "Would a focused review of that possible project help?" };
const TIMING = { expiresInMinutes: 60, reconsiderInMinutes: null };
afterEach(async () => { await disposeCompositionFixtures(); });

function input(): ProactiveReviewInput {
  return { reviewId: "proactive-super-review", modelProfileId: "default", signal: new AbortController().signal,
    context: { kind: "learning_knowledge_reference_v1", authority: "passive_reference",
      presenceEffect: "does_not_authorize_actions_or_add_user_intent", repositoryRevision: 7, knowledgeRevision: 4,
      referenceTime: new Date(NOW).toISOString(), omitted: 2,
      entries: ["unrelated-source", "selected-source"].map(id => ({ kind: "candidate", id, version: "version-3",
        content: `${id} original content`, tags: [], score: 40, reason: "Tentative", certainty: "inferred",
        mutable: true, lastReinforcedAt: null, reconsiderAt: null })) },
    recentProposals: [{ id: "prior-proposal", reviewId: "prior-review", sessionId: "prior-session",
      knowledgeRevision: 3, title: "A previous idea", message: "Prior message", reason: "Prior reason",
      sources: [{ kind: "candidate", id: "unrelated-source", version: "version-2" },
        { kind: "candidate", id: "selected-source", version: "version-3" }],
      createdAt: new Date(NOW - 3_600_000).toISOString(), expiresAt: new Date(NOW + 3_600_000).toISOString(),
      status: "dismissed", settledAt: new Date(NOW - 1000).toISOString() }] };
}

async function fixture(policy: "supervisor-worker-v1" | "execution-agent-v1" = "supervisor-worker-v1") {
  const base = await createRuntimeConfig();
  await writeFile(base.requestRunner.configPath, JSON.stringify({ schemaVersion: 2,
    models: { defaults: { profileId: "default", steps: {} } },
    context: { outputReserveTokens: 200, safetyReserveTokens: 50, attachmentReserveTokens: 1 },
    stepDefaults: { timeoutMs: 5000 }, steps: {} }));
  const config: RuntimeConfig = { ...base, modelExecutionPolicies: { default: { policy } },
    models: { defaults: { profileId: "default" }, providers: { cloud: { type: "openai" } },
      profiles: { default: { provider: "cloud", model: "scripted", contextWindowTokens: 8192 } } } };
  const invoke = vi.fn<ModelGatewayClient["invoke"]>();
  const invokeRaw = vi.fn<ModelGatewayClient["invokeRaw"]>(async () => { throw new Error("unexpected_raw"); });
  let now = NOW;
  const model = createRuntimeProactiveModel({ config, models: { invoke, invokeRaw }, now: () => now });
  return { model, invoke, invokeRaw, advance: (milliseconds: number) => { now += milliseconds; } };
}

function response(value: unknown) { return { text: JSON.stringify(value), meta: { providerCompletionReason: "stop" } }; }
function receivedMessages(value: unknown): readonly ChatMessage[] {
  expect(Array.isArray(value)).toBe(true);
  return value as readonly ChatMessage[];
}
function memoryProgress() {
  let saved: CoWorkerReviewProgress | undefined;
  const port: ReviewProgressPort = { read: () => saved, save: async value => { saved = value; } };
  return port;
}
function queueProposal(f: Awaited<ReturnType<typeof fixture>>) {
  for (const value of [SOURCES, OBJECTIVE, MESSAGE, TIMING]) f.invoke.mockResolvedValueOnce(response(value));
}

describe("SUPER proactive responsibilities", () => {
  test("no sources skips objective and authoring while retaining future reconsideration", async () => {
    const f = await fixture();
    f.invoke.mockResolvedValueOnce(response({ sourceRefs: [] })).mockResolvedValueOnce(response({ reconsiderInMinutes: 10 }));
    await expect(f.model.review(input())).resolves.toMatchObject({ kind: "none", title: null, message: null,
      sources: [], expiresAt: null, reconsiderAt: new Date(NOW + 600_000).toISOString() });
    expect(f.invoke).toHaveBeenCalledTimes(2); expect(f.invokeRaw).not.toHaveBeenCalled();
  });

  test("declined objective skips message but still reviews timing", async () => {
    const f = await fixture();
    for (const value of [SOURCES, { objective: null }, { reconsiderInMinutes: null }]) f.invoke.mockResolvedValueOnce(response(value));
    await expect(f.model.review(input())).resolves.toMatchObject({ kind: "none", sources: [], reconsiderAt: null });
    expect(f.invoke).toHaveBeenCalledTimes(3);
  });

  test("four calls each receive only their bound responsibility and original source subset", async () => {
    const f = await fixture(); const review = input(); queueProposal(f);
    await expect(f.model.review(review)).resolves.toEqual({ kind: "proposal", ...MESSAGE,
      reason: "No explanation provided by the model.", sources: [{ kind: "candidate", id: "selected-source", version: "version-3" }],
      expiresAt: new Date(NOW + 3_600_000).toISOString(), reconsiderAt: null });
    expect(f.invoke).toHaveBeenCalledTimes(4);
    const sourceMessages = receivedMessages(f.invoke.mock.calls[0]![0].messages);
    expect(sourceMessages.map(({ role }) => role)).toEqual(["system", "system", "system"]);
    expect(JSON.stringify(sourceMessages)).not.toContain("prior-proposal");
    const knowledge = JSON.parse(sourceMessages[2]!.content);
    expect(knowledge).toMatchObject({ authority: "passive_reference", omitted: 2,
      entries: [{ ref: "k1", kind: "candidate", certainty: "inferred" }, { ref: "k2", kind: "candidate", certainty: "inferred" }] });
    expect(knowledge.entries.every((entry: Record<string, unknown>) => !Object.hasOwn(entry, "id") && !Object.hasOwn(entry, "version"))).toBe(true);
    const objectiveMessages = receivedMessages(f.invoke.mock.calls[1]![0].messages);
    expect(JSON.parse(objectiveMessages[3]!.content).proposals).toMatchObject([
      { id: "prior-proposal", sourceRefs: ["k2"], unavailableSourceCount: 1 },
    ]);
    const authoring = receivedMessages(f.invoke.mock.calls[2]![0].messages);
    expect(JSON.parse(authoring[1]!.content)).toMatchObject({ objective: OBJECTIVE.objective, actionAuthority: "none" });
    expect(JSON.parse(authoring[2]!.content)).toMatchObject({ entries: [review.context.entries[1]], omitted: 0 });
    expect(JSON.stringify(authoring)).not.toContain("unrelated-source");
    expect(JSON.stringify(authoring)).not.toContain("prior-proposal");
    const timing = receivedMessages(f.invoke.mock.calls[3]![0].messages);
    expect(JSON.parse(timing[1]!.content)).toMatchObject({ delayOrigin: "review_completion", message: MESSAGE });
    expect(f.invokeRaw).not.toHaveBeenCalled();
  });

  test("snapshot source versions remain exact and temporal durations start at completion", async () => {
    const f = await fixture(); const review = input();
    f.invoke.mockImplementationOnce(async () => {
      Object.assign(review.context.entries[1]!, { id: "replacement", version: "changed" });
      return response(SOURCES);
    }).mockResolvedValueOnce(response(OBJECTIVE)).mockResolvedValueOnce(response(MESSAGE))
      .mockImplementationOnce(async () => { f.advance(120_000); return response(TIMING); });
    const decision = await f.model.review(review);
    expect(decision.sources).toEqual([{ kind: "candidate", id: "selected-source", version: "version-3" }]);
    expect(decision.expiresAt).toBe(new Date(NOW + 3_720_000).toISOString());
  });

  test.each([
    [{ sourceRefs: ["k99"] }, "proactive_source_stale_or_unknown"],
    [{ sourceRefs: ["k2", "k2"] }, "proactive_source_duplicate"],
    [{ sourceRefs: ["k2"], objective: "extra decision" }, "proactive_staged_output_fields_invalid"],
  ])("source selection rejects unknown, duplicate or extra decisions (%j)", async (value, error) => {
    const f = await fixture(); f.invoke.mockResolvedValueOnce(response(value));
    await expect(f.model.review(input())).rejects.toThrow(error);
    expect(f.invoke).toHaveBeenCalledOnce();
  });

  test.each([
    [{ objective: "" }, 2, "proactive_objective_invalid"],
    [{ title: "", message: "Valid message" }, 3, "proactive_title_invalid"],
    [{ ...MESSAGE, sources: ["k1"] }, 3, "proactive_staged_output_fields_invalid"],
    [{ expiresInMinutes: 0, reconsiderInMinutes: null }, 4, "proactive_time_not_future"],
    [{ expiresInMinutes: 43201, reconsiderInMinutes: null }, 4, "proactive_time_too_distant"],
  ])("a failed bounded responsibility does not produce a decision (%j)", async (invalid, stage, error) => {
    const f = await fixture();
    for (const value of [SOURCES, OBJECTIVE, MESSAGE].slice(0, Number(stage) - 1)) f.invoke.mockResolvedValueOnce(response(value));
    f.invoke.mockResolvedValueOnce(response(invalid));
    await expect(f.model.review(input())).rejects.toThrow(String(error));
    expect(f.invoke).toHaveBeenCalledTimes(Number(stage));
  });

  test.each([1, 2, 3, 4])("cancellation at call %i prevents a final result", async stage => {
    const f = await fixture(); const abort = new AbortController();
    const outputs = [SOURCES, OBJECTIVE, MESSAGE, TIMING];
    for (const value of outputs.slice(0, stage - 1)) f.invoke.mockResolvedValueOnce(response(value));
    f.invoke.mockImplementationOnce(async () => { abort.abort(new Error("proactive_interactive_preempted")); return response(outputs[stage - 1]); });
    await expect(f.model.review({ ...input(), signal: abort.signal })).rejects.toThrow("proactive_interactive_preempted");
    expect(f.invoke).toHaveBeenCalledTimes(stage);
  });

  test("accepted responsibilities survive quota deferral without recharging the prefix", async () => {
    const f = await fixture(); const progress = memoryProgress();
    f.invoke.mockResolvedValueOnce(response(SOURCES)).mockResolvedValueOnce(response(OBJECTIVE))
      .mockRejectedValueOnce(new Error("co_worker_model_daily_budget_exhausted"));
    await expect(f.model.review({ ...input(), progress })).rejects.toThrow("co_worker_model_daily_budget_exhausted");
    expect(progress.read()?.stages.map(stage => stage.key)).toEqual(["sources", "objective"]);
    f.advance(300_000);
    f.invoke.mockResolvedValueOnce(response(MESSAGE)).mockResolvedValueOnce(response(TIMING));
    await expect(f.model.review({ ...input(), context: { ...input().context, referenceTime: new Date(NOW + 300_000).toISOString() }, progress }))
      .resolves.toMatchObject({ kind: "proposal" });
    expect(f.invoke).toHaveBeenCalledTimes(5);
  });

  test("cached timing retains its original deadline and only stale timing is renewed", async () => {
    const f = await fixture(); const progress = memoryProgress(); queueProposal(f);
    const first = await f.model.review({ ...input(), progress });
    f.advance(600_000);
    expect((await f.model.review({ ...input(), progress })).expiresAt).toBe(first.expiresAt);
    expect(f.invoke).toHaveBeenCalledTimes(4);
    f.advance(3_600_000);
    f.invoke.mockResolvedValueOnce(response(TIMING));
    expect((await f.model.review({ ...input(), progress })).expiresAt).toBe(new Date(NOW + 7_800_000).toISOString());
    expect(f.invoke).toHaveBeenCalledTimes(5);
  });

  test("changed canonical sources invalidate all earlier responsibilities", async () => {
    const f = await fixture(); const progress = memoryProgress();
    f.invoke.mockResolvedValueOnce(response(SOURCES)).mockRejectedValueOnce(new Error("co_worker_resources_busy"));
    await expect(f.model.review({ ...input(), progress })).rejects.toThrow("co_worker_resources_busy");
    const changed = input(); Object.assign(changed.context.entries[1]!, { version: "version-4" });
    queueProposal(f);
    expect((await f.model.review({ ...changed, progress })).sources[0]?.version).toBe("version-4");
    expect(f.invoke).toHaveBeenCalledTimes(6);
  });

  test("EA keeps its original one-call format and ignores SUPER progress", async () => {
    const f = await fixture("execution-agent-v1"); const progress = memoryProgress();
    const decision = { kind: "proposal", ...MESSAGE, reason: "Useful", expiresAt: new Date(NOW + 3_600_000).toISOString(),
      reconsiderAt: null, sources: [{ kind: "candidate", id: "selected-source", version: "version-3" }] };
    f.invoke.mockResolvedValueOnce(response(decision));
    await expect(f.model.review({ ...input(), progress })).resolves.toEqual(decision);
    expect(f.invoke).toHaveBeenCalledOnce(); expect(progress.read()).toBeUndefined();
    expect(f.invoke.mock.calls[0]![0].format).toMatchObject({ name: "co_worker_proactive_decision" });
  });
});

test.each([
  [STAGED_PROACTIVE_SELECTION_FORMAT, 0], [STAGED_PROACTIVE_OBJECTIVE_FORMAT, 1],
  [STAGED_PROACTIVE_AUTHORING_FORMAT, 2], [createStagedProactiveTimingFormat(true), 0],
  [createStagedProactiveTimingFormat(false), 0],
] as const)("SUPER schema %j remains compatible with provider projection", (format, count) => {
  expect(projectOllamaFormat(format).diagnostics).toHaveLength(count);
  expect(projectOpenAIResponsesFormat(format).format?.schema).toEqual(format.schema);
});
