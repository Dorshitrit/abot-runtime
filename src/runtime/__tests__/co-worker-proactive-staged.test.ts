import * as logger from "../observability/debug-logger.js";
import { buildOpenAIResponsesPayload } from "../../model-gateway/providers/openai/payload.js";
import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createRuntimeProactiveModel } from "../passive-learning/proactive/model.js";
import type { ProactiveReviewInput } from "../passive-learning/proactive/contracts.js";
import type { ModelGatewayClient, RuntimeConfig, SessionStore } from "../ports.js";
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
const MESSAGE = { title: "A review idea", message: "Would a focused review of that possible project help?",
  handoffBrief: "SPARK background: selected-source original content suggests a possible project review; the user's request is pending." };
const CONTENT = [MESSAGE.message, MESSAGE.title, MESSAGE.handoffBrief];
const TIMING = { expiresInMinutes: 60, reconsiderInMinutes: null };
afterEach(async () => { await disposeCompositionFixtures(); vi.restoreAllMocks(); });

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

async function fixture(
  policy: "supervisor-worker-v1" | "execution-agent-v1" = "supervisor-worker-v1",
  sessions?: Pick<SessionStore, "getSessionById">,
) {
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
  const model = createRuntimeProactiveModel({ config, models: { invoke, invokeRaw }, sessions, now: () => now });
  return { model, invoke, invokeRaw, config, advance: (milliseconds: number) => { now += milliseconds; } };
}

function response(value: unknown) { return { text: typeof value === "string" ? value : JSON.stringify(value), meta: { providerCompletionReason: "stop" } }; }
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
  for (const value of [SOURCES, OBJECTIVE, ...CONTENT, TIMING]) f.invoke.mockResolvedValueOnce(response(value));
}

function styleSession(content = "אפשר לדבר בקצרה ובטבעיות?") {
  return { id: "spark-companion", kind: "spark" as const, title: "Renamed",
    createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
    lastAgentMode: "reasoning" as const, messageCount: 1,
    messages: [{ id: "human-1", role: "user" as const, content, createdAt: new Date(NOW).toISOString() }] };
}
function passiveStyle(messages: readonly ChatMessage[]) {
  return messages.flatMap(message => {
    if (!message.content.startsWith("{")) return [];
    const value = JSON.parse(message.content);
    return value.kind === "co_worker_proactive_conversation_style_v1" ? [value] : [];
  });
}

describe("proactive presentation uses canonical human style only", () => {
  test("SUPER adds one passive reference only to authoring and preserves the other stage inputs", async () => {
    const baseline = await fixture(); queueProposal(baseline); await baseline.model.review(input());
    const session = styleSession();
    const getSessionById = vi.fn(async () => session);
    const f = await fixture("supervisor-worker-v1", { getSessionById });
    queueProposal(f); const result = await f.model.review(input());
    expect(result).toMatchObject({ ...MESSAGE, sources: [{ kind: "candidate", id: "selected-source", version: "version-3" }] });
    expect(getSessionById).toHaveBeenCalledExactlyOnceWith("spark-companion");
    for (const index of [0, 1, 3, 4, 5]) {
      expect(f.invoke.mock.calls[index]![0].messages).toEqual(baseline.invoke.mock.calls[index]![0].messages);
    }
    const messages = receivedMessages(f.invoke.mock.calls[2]![0].messages);
    expect(messages.every(message => message.role === "system")).toBe(true);
    expect(passiveStyle(messages)).toMatchObject([{ authority: "passive_reference",
      purpose: "language_and_style_only", applicability: "eligible_proposal_title_and_message_only",
      entries: [{ messageId: "human-1", content: session.messages[0]!.content }] }]);
    expect(JSON.stringify(messages).split(session.messages[0]!.content)).toHaveLength(2);
  });

  test("direct review gets the scoped reference once without another provider call or user turn", async () => {
    const session = styleSession("Please keep the reply conversational.");
    const f = await fixture("execution-agent-v1", { getSessionById: async () => session });
    f.invoke.mockResolvedValueOnce(response({ kind: "none", title: null, message: null,
      handoffBrief: null, reason: null, sources: [], expiresAt: null, reconsiderAt: null }));
    await expect(f.model.review(input())).resolves.toMatchObject({ kind: "none" });
    expect(f.invoke).toHaveBeenCalledOnce();
    const messages = receivedMessages(f.invoke.mock.calls[0]![0].messages);
    expect(messages.every(message => message.role === "system")).toBe(true);
    expect(passiveStyle(messages)).toHaveLength(1);
    expect(passiveStyle(messages)[0].entries[0].content).toBe(session.messages[0]!.content);
  });

  test.each(["change", "clear"] as const)("a %s invalidates cached authoring without recharging source/objective selection", async action => {
    let session = styleSession();
    const f = await fixture("supervisor-worker-v1", { getSessionById: async () => session });
    const progress = memoryProgress(); queueProposal(f);
    await f.model.review({ ...input(), progress });
    await f.model.review({ ...input(), progress });
    expect(f.invoke).toHaveBeenCalledTimes(6);
    session = action === "change" ? styleSession("Please now write in English.") : { ...session, messages: [], messageCount: 0 };
    for (const value of [...CONTENT, TIMING]) f.invoke.mockResolvedValueOnce(response(value));
    await f.model.review({ ...input(), progress });
    expect(f.invoke).toHaveBeenCalledTimes(10);
    const messages = receivedMessages(f.invoke.mock.calls[6]![0].messages);
    expect(passiveStyle(messages)).toHaveLength(action === "change" ? 1 : 0);
    if (action === "change") expect(passiveStyle(messages)[0].entries[0].content).toBe(session.messages[0]!.content);
    expect(progress.read()?.stages.map(stage => stage.key)).toEqual(["sources", "objective", "message.raw.v1", "title", "handoff", "timing"]);
  });
});

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

  test("six calls each receive only their bound responsibility and original source subset", async () => {
    const f = await fixture(); const review = input(); queueProposal(f);
    await expect(f.model.review(review)).resolves.toEqual({ kind: "proposal", ...MESSAGE,
      reason: "No explanation provided by the model.", sources: [{ kind: "candidate", id: "selected-source", version: "version-3" }],
      expiresAt: new Date(NOW + 3_600_000).toISOString(), reconsiderAt: null });
    expect(f.invoke).toHaveBeenCalledTimes(6);
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
    const title = receivedMessages(f.invoke.mock.calls[3]![0].messages);
    expect(JSON.parse(title[2]!.content)).toMatchObject({ message: MESSAGE.message, authority: "passive_reference" });
    expect(JSON.stringify(title)).not.toContain("original content");
    const handoff = receivedMessages(f.invoke.mock.calls[4]![0].messages);
    expect(JSON.parse(handoff[3]!.content)).toMatchObject({ entries: [review.context.entries[1]] });
    expect(JSON.stringify(handoff)).not.toContain("unrelated-source");
    const timing = receivedMessages(f.invoke.mock.calls[5]![0].messages);
    expect(JSON.parse(timing[1]!.content)).toMatchObject({ delayOrigin: "review_completion",
      message: { title: MESSAGE.title, message: MESSAGE.message } });
    expect(JSON.stringify(timing)).not.toContain(MESSAGE.handoffBrief);
    expect(f.invoke.mock.calls.map(([call]) => call.format)).toEqual([
      STAGED_PROACTIVE_SELECTION_FORMAT, STAGED_PROACTIVE_OBJECTIVE_FORMAT,
      ...CONTENT.map(() => STAGED_PROACTIVE_AUTHORING_FORMAT), createStagedProactiveTimingFormat(true),
    ]);
    expect(f.invokeRaw).not.toHaveBeenCalled();
  });

  test("snapshot source versions remain exact and temporal durations start at completion", async () => {
    const f = await fixture(); const review = input();
    f.invoke.mockImplementationOnce(async () => {
      Object.assign(review.context.entries[1]!, { id: "replacement", version: "changed" });
      return response(SOURCES);
    }).mockResolvedValueOnce(response(OBJECTIVE));
    for (const value of CONTENT) f.invoke.mockResolvedValueOnce(response(value));
    f.invoke.mockImplementationOnce(async () => { f.advance(120_000); return response(TIMING); });
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
    ["", 3, "proactive_message_invalid"],
    [" \n\t ", 3, "proactive_message_invalid"],
    ["x".repeat(4001), 3, "proactive_message_invalid"],
    ["", 4, "proactive_title_invalid"],
    ["x".repeat(161), 4, "proactive_title_invalid"],
    ["", 5, "proactive_handoff_brief_invalid"],
    ["x".repeat(4001), 5, "proactive_handoff_brief_invalid"],
    [{ expiresInMinutes: 0, reconsiderInMinutes: null }, 6, "proactive_time_not_future"],
    [{ expiresInMinutes: 43201, reconsiderInMinutes: null }, 6, "proactive_time_too_distant"],
  ])("a failed bounded responsibility does not produce a decision (%j)", async (invalid, stage, error) => {
    const f = await fixture();
    for (const value of [SOURCES, OBJECTIVE, ...CONTENT].slice(0, Number(stage) - 1)) f.invoke.mockResolvedValueOnce(response(value));
    f.invoke.mockResolvedValueOnce(response(invalid));
    await expect(f.model.review(input())).rejects.toThrow(String(error));
    expect(f.invoke).toHaveBeenCalledTimes(Number(stage));
  });

  test.each([1, 2, 3, 4, 5, 6])("cancellation at call %i prevents a final result", async stage => {
    const f = await fixture(); const abort = new AbortController();
    const outputs = [SOURCES, OBJECTIVE, ...CONTENT, TIMING];
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
    for (const value of [...CONTENT, TIMING]) f.invoke.mockResolvedValueOnce(response(value));
    await expect(f.model.review({ ...input(), context: { ...input().context, referenceTime: new Date(NOW + 300_000).toISOString() }, progress }))
      .resolves.toMatchObject({ kind: "proposal" });
    expect(f.invoke).toHaveBeenCalledTimes(7);
  });

  test("cached timing retains its original deadline and only stale timing is renewed", async () => {
    const f = await fixture(); const progress = memoryProgress(); queueProposal(f);
    const first = await f.model.review({ ...input(), progress });
    f.advance(600_000);
    expect((await f.model.review({ ...input(), progress })).expiresAt).toBe(first.expiresAt);
    expect(f.invoke).toHaveBeenCalledTimes(6);
    f.advance(3_600_000);
    f.invoke.mockResolvedValueOnce(response(TIMING));
    expect((await f.model.review({ ...input(), progress })).expiresAt).toBe(new Date(NOW + 7_800_000).toISOString());
    expect(f.invoke).toHaveBeenCalledTimes(7);
  });

  test("changed canonical sources invalidate all earlier responsibilities", async () => {
    const f = await fixture(); const progress = memoryProgress();
    f.invoke.mockResolvedValueOnce(response(SOURCES)).mockRejectedValueOnce(new Error("co_worker_resources_busy"));
    await expect(f.model.review({ ...input(), progress })).rejects.toThrow("co_worker_resources_busy");
    const changed = input(); Object.assign(changed.context.entries[1]!, { version: "version-4" });
    queueProposal(f);
    expect((await f.model.review({ ...changed, progress })).sources[0]?.version).toBe("version-4");
    expect(f.invoke).toHaveBeenCalledTimes(8);
  });

  test("raw bodies preserve quotes, multiline text and boundary lengths through proposal assembly", async () => {
    const f = await fixture();
    const authored = { message: '  נדל"ן \nline with \"quotes\" and C:\\work 🧪\n',
      title: "כ".repeat(160), handoffBrief: "ר".repeat(4000) };
    for (const value of [SOURCES, OBJECTIVE, authored.message, authored.title, authored.handoffBrief, TIMING])
      f.invoke.mockResolvedValueOnce(response(value));
    await expect(f.model.review(input())).resolves.toMatchObject(authored);
    expect(f.invoke).toHaveBeenCalledTimes(6);
  });

  test.each([3, 4, 5])("provider truncation at raw stage %i cannot become an accepted proposal", async stage => {
    const f = await fixture(); const progress = memoryProgress();
    const outputs = [SOURCES, OBJECTIVE, ...CONTENT, TIMING];
    for (const value of outputs.slice(0, stage - 1)) f.invoke.mockResolvedValueOnce(response(value));
    f.invoke.mockResolvedValueOnce({ text: "Incomplete body", meta: { providerCompletionReason: "length" } });
    await expect(f.model.review({ ...input(), progress })).rejects.toThrow("output_incomplete");
    expect(progress.read()?.stages).toHaveLength(stage - 1);
    expect(f.invoke).toHaveBeenCalledTimes(stage);
  });

  test.each([3, 4, 5])("resumes after %i accepted stages without paying to rewrite their bodies", async accepted => {
    const f = await fixture(); const progress = memoryProgress();
    const outputs = [SOURCES, OBJECTIVE, ...CONTENT, TIMING];
    for (const value of outputs.slice(0, accepted)) f.invoke.mockResolvedValueOnce(response(value));
    f.invoke.mockRejectedValueOnce(new Error("co_worker_resources_busy"));
    await expect(f.model.review({ ...input(), progress })).rejects.toThrow("co_worker_resources_busy");
    const prefix = structuredClone(progress.read()!.stages);
    f.invoke.mockClear();
    for (const value of outputs.slice(accepted)) f.invoke.mockResolvedValueOnce(response(value));
    await expect(f.model.review({ ...input(), progress })).resolves.toMatchObject(MESSAGE);
    expect(f.invoke).toHaveBeenCalledTimes(6 - accepted);
    expect(progress.read()!.stages.slice(0, accepted)).toEqual(prefix);
  });

  test("incompatible saved JSON authoring is regenerated while valid source decisions are reused", async () => {
    const f = await fixture(); const progress = memoryProgress(); queueProposal(f);
    await f.model.review({ ...input(), progress });
    const saved = progress.read()!;
    await progress.save({ ...saved, stages: saved.stages.map(stage => stage.key === "message.raw.v1"
      ? { ...stage, fingerprint: "0".repeat(64), response: JSON.stringify(MESSAGE) } : stage) });
    f.invoke.mockClear();
    for (const value of [...CONTENT, TIMING]) f.invoke.mockResolvedValueOnce(response(value));
    await expect(f.model.review({ ...input(), progress })).resolves.toMatchObject(MESSAGE);
    expect(f.invoke).toHaveBeenCalledTimes(4);
    expect(progress.read()!.stages.slice(0, 2)).toEqual(saved.stages.slice(0, 2));
    expect(progress.read()!.stages[2]!.response).toBe(MESSAGE.message);
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
  [createStagedProactiveTimingFormat(true), 0],
  [createStagedProactiveTimingFormat(false), 0],
] as const)("SUPER schema %j remains compatible with provider projection", (format, count) => {
  expect(projectOllamaFormat(format).diagnostics).toHaveLength(count);
  expect(projectOpenAIResponsesFormat(format).format?.schema).toEqual(format.schema);
});


test("the actual six-stage route isolates raw calibration and reports text diagnostics", async () => {
  const trace = vi.spyOn(logger, "traceDebug").mockImplementation(() => {});
  const f = await fixture();
  f.config.models!.defaults!.steps = { "learning.batch": "learning.batch" };
  f.config.models!.profiles!.default!.calibration = { "learning.batch": {
    format: "json", instructions: ["STRUCTURED_CALIBRATION_MARKER"],
  } };
  queueProposal(f);
  await f.model.review(input());
  const starts = trace.mock.calls.filter(([, event]) => event === "step.started").map(([, , fields]) => fields);
  expect(starts).toHaveLength(6);
  for (const [index, [call]] of f.invoke.mock.calls.entries()) {
    const serialized = JSON.stringify(buildOpenAIResponsesPayload({ ...call, messages: call.messages }));
    if ([2, 3, 4].includes(index)) {
      expect(serialized).not.toContain("STRUCTURED_CALIBRATION_MARKER");
      expect(starts[index]).toMatchObject({ outputContract: "text", schemaCharacterCount: 0, schemaRootType: "" });
    } else {
      expect(serialized).toContain("STRUCTURED_CALIBRATION_MARKER");
      expect(starts[index]).toMatchObject({ outputContract: "json_schema" });
    }
  }
});


describe("call-free proactive completion proof", () => {
  test.each(["unchanged", "partial", "legacy", "style", "source", "config", "timing", "invalid"])(
    "checks the actual replay contract for %s without calls, writes or execution traces", async change => {
      let session = styleSession();
      const f = await fixture("supervisor-worker-v1", { getSessionById: async () => session });
      const progress = memoryProgress(); const review = { ...input(), progress };
      queueProposal(f); await f.model.review(review);
      const saved = progress.read()!;
      if (change === "partial") await progress.save({ ...saved, stages: saved.stages.slice(0, 3) });
      if (change === "legacy") await progress.save({ ...saved, stages: saved.stages.map(stage =>
        stage.key === "message.raw.v1" ? { ...stage, key: "message" } : stage) });
      if (change === "style") session = styleSession("Please write in English now.");
      if (change === "source") Object.assign(review.context.entries[1]!, { version: "changed" });
      if (change === "config") f.config.models!.profiles!.default!.model = "changed-model";
      if (change === "timing") f.advance(3_600_001);
      if (change === "invalid") await progress.save({ ...saved, stages: saved.stages.map(stage =>
        stage.key === "title" ? { ...stage, response: "" } : stage) });
      const before = structuredClone(progress.read());
      const save = vi.spyOn(progress, "save");
      const trace = vi.spyOn(logger, "traceDebug").mockImplementation(() => {});
      f.invoke.mockClear();
      expect(await f.model.canCompleteSavedReview!(review)).toBe(change === "unchanged");
      expect(f.invoke).not.toHaveBeenCalled(); expect(f.invokeRaw).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled(); expect(trace).not.toHaveBeenCalled();
      expect(progress.read()).toEqual(before);
    });

  test.each([false, true])("declined review replays its exact shorter path, objective=%s", async hasSources => {
    const f = await fixture(); const progress = memoryProgress();
    const outputs = hasSources ? [SOURCES, { objective: null }, { reconsiderInMinutes: null }]
      : [{ sourceRefs: [] }, { reconsiderInMinutes: null }];
    for (const output of outputs) f.invoke.mockResolvedValueOnce(response(output));
    await f.model.review({ ...input(), progress }); f.invoke.mockClear();
    expect(await f.model.canCompleteSavedReview!({ ...input(), progress })).toBe(true);
    expect(f.invoke).not.toHaveBeenCalled();
  });

  test("EA cannot enter the staged replay path", async () => {
    const f = await fixture("execution-agent-v1");
    expect(await f.model.canCompleteSavedReview!(input())).toBe(false);
    expect(f.invoke).not.toHaveBeenCalled();
  });
});
