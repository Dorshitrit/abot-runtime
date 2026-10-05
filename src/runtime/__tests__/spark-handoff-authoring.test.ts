import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MAX_SPARK_HANDOFF_BRIEF_CHARACTERS } from "../../sessions/spark-handoff-brief.js";
import { assertAssistantInitiative } from "../../sessions/assistant-initiative.js";
import { buildContextWindow } from "../../sessions/context-window.js";
import { SPARK_SESSION_ID } from "../../sessions/spark-session.js";
import { createFileSessionStore } from "../adapters/file-session-store.js";
import type { ProactiveDecision, ProactiveReviewInput } from "../passive-learning/proactive/contracts.js";
import { buildProactiveReviewMessages, PROACTIVE_DECISION_FORMAT } from "../passive-learning/proactive/model.js";
import { decodeProactiveModelDecision } from "../passive-learning/proactive/model-output.js";
import { STAGED_PROACTIVE_AUTHORING_FORMAT } from "../passive-learning/proactive/staged-format.js";
import { decodeStagedProactiveMessage, decodeStagedProactiveTitle, decodeStagedProactiveHandoffBrief } from "../passive-learning/proactive/staged-output.js";
import { buildStagedProactiveObjectiveMessages, buildStagedProactiveTimingMessages,
  createStagedProactivePresentation } from "../passive-learning/proactive/staged-context.js";
import { createProactiveStateStore } from "../passive-learning/proactive/store.js";
import { validateJsonSchemaValue } from "../model/json-schema-value.js";

const now = Date.parse("2026-10-02T00:00:00Z");
const source = { kind: "candidate" as const, id: "original-insight", version: "7" };
const brief = "Background from SPARK: an inferred project interest may benefit from review. No work has been requested in this new conversation; the user's next message will define it.";
const authored = { title: "A possible review", message: "Would a focused review help?", handoffBrief: brief };
const decision: ProactiveDecision = { kind: "proposal", ...authored, reason: "Possible ongoing interest",
  sources: [source], expiresAt: new Date(now + 3_600_000).toISOString(), reconsiderAt: null };
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function input(): ProactiveReviewInput {
  return { reviewId: "brief-review", modelProfileId: "selected-model", signal: new AbortController().signal,
    recentProposals: [], context: { kind: "learning_knowledge_reference_v1", authority: "passive_reference",
      presenceEffect: "does_not_authorize_actions_or_add_user_intent", repositoryRevision: 8, knowledgeRevision: 7,
      referenceTime: new Date(now).toISOString(), omitted: 0, entries: [{ ...source,
        content: "The user may be developing a project", tags: [], score: 40, reason: "Tentative",
        certainty: "inferred", mutable: true, lastReinforcedAt: null, reconsiderAt: null }] } };
}

async function directory() {
  const parent = join(process.cwd(), ".codex/artifacts/spark-handoff-refinement-20261002");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "authoring-")); roots.push(root); return root;
}

describe("bound SPARK handoff authoring", () => {
  test("direct JSON and staged raw decoders preserve exact authored content and require a brief", () => {
    expect(validateJsonSchemaValue(PROACTIVE_DECISION_FORMAT.schema, decision)).toBeUndefined();
    expect(STAGED_PROACTIVE_AUTHORING_FORMAT).toEqual({ type: "text", calibrationInstructions: "omit" });
    expect(decodeProactiveModelDecision(JSON.stringify(decision), input())).toEqual(decision);
    expect(decodeStagedProactiveMessage(authored.message)).toBe(authored.message);
    expect(decodeStagedProactiveTitle(authored.title)).toBe(authored.title);
    expect(decodeStagedProactiveHandoffBrief(authored.handoffBrief)).toBe(authored.handoffBrief);
    expect(() => decodeStagedProactiveHandoffBrief("")).toThrow("proactive_handoff_brief_invalid");
    expect(() => decodeProactiveModelDecision(JSON.stringify({ ...decision, handoffBrief: undefined }), input()))
      .toThrow("proactive_handoff_brief_invalid");
  });

  test.each([null, "", "  ", "x".repeat(MAX_SPARK_HANDOFF_BRIEF_CHARACTERS + 1)])(
    "rejects an invalid proposal brief without fallback or truncation", (handoffBrief) => {
      expect(() => decodeProactiveModelDecision(JSON.stringify({ ...decision, handoffBrief }), input()))
        .toThrow("proactive_handoff_brief_invalid");
      expect(() => decodeStagedProactiveHandoffBrief(handoffBrief as string))
        .toThrow("proactive_handoff_brief_invalid");
    },
  );

  test("none requires null and a valid brief never permits stale source versions", () => {
    const none = { kind: "none", title: null, message: null, handoffBrief: null, reason: "No helpful proposal",
      sources: [], expiresAt: null, reconsiderAt: null };
    expect(decodeProactiveModelDecision(JSON.stringify(none), input())).toEqual(none);
    expect(() => decodeProactiveModelDecision(JSON.stringify({ ...none, handoffBrief: brief }), input()))
      .toThrow("proactive_none_payload_invalid");
    expect(() => decodeProactiveModelDecision(JSON.stringify({ ...decision, sources: [{ ...source, version: "6" }] }), input()))
      .toThrow("proactive_source_stale_or_unknown");
  });

  test("future reviews, selection and timing do not receive saved handoff context", () => {
    const review: ProactiveReviewInput = { ...input(), recentProposals: [{ id: "settled", reviewId: "old-review", sessionId: SPARK_SESSION_ID,
      knowledgeRevision: 7, ...authored, reason: decision.reason, sources: [source],
      createdAt: new Date(now - 1000).toISOString(), expiresAt: decision.expiresAt!, status: "delivered",
      settledAt: new Date(now).toISOString() }] };
    const direct = buildProactiveReviewMessages(review);
    expect(JSON.stringify(direct)).not.toContain(brief);
    expect(JSON.parse(direct[3]!.content).proposals[0]).not.toHaveProperty("handoffBrief");
    const selection = createStagedProactivePresentation(review, direct);
    const objective = buildStagedProactiveObjectiveMessages({ reviewId: review.reviewId,
      sources: review.context.entries, priorProposals: selection.priorProposals });
    const timing = buildStagedProactiveTimingMessages({ reviewId: review.reviewId,
      sources: review.context.entries, referenceTime: review.context.referenceTime, message: authored });
    expect(JSON.stringify([...selection.messages, ...objective, ...timing])).not.toContain(brief);
    expect(JSON.parse(timing[1]!.content).message).toEqual({ title: authored.title, message: authored.message });
  });

  test("proposal and session snapshots retain brief provenance across restart without adding it to ordinary history", async () => {
    const root = await directory();
    const store = createProactiveStateStore(root);
    const state = await store.commitReview({ reviewId: "persisted", expectedRevision: 0, knowledgeRevision: 7, decision, now });
    const proposal = state.proposals[0]!;
    expect((await createProactiveStateStore(root).read()).proposals[0]).toMatchObject({ handoffBrief: brief, sources: [source] });
    const sessionsDir = join(root, "sessions");
    const sessions = createFileSessionStore({ sessionsDir });
    const initiative = { kind: "proactive_proposal_v1" as const, proposalId: proposal.id, reason: proposal.reason,
      sources: proposal.sources, handoffBrief: proposal.handoffBrief, handoffTitle: proposal.title };
    await sessions.appendAssistantInitiative!(SPARK_SESSION_ID, { title: proposal.title, content: proposal.message, initiative });
    const restarted = createFileSessionStore({ sessionsDir });
    expect((await restarted.getSessionSnapshot(SPARK_SESSION_ID))?.messages[0]?.initiative).toEqual(initiative);
    const saved = (await restarted.getSessionById(SPARK_SESSION_ID))!;
    expect(buildContextWindow(saved, 10)).toEqual([{ role: "assistant", content: proposal.message }]);
    expect(await restarted.getSessionById("ordinary-work")).toBeNull();
    expect(saved.requests ?? []).toEqual([]);
  });

  test("legacy stored proposals remain brief-less and malformed new metadata is rejected", async () => {
    const root = await directory();
    const store = createProactiveStateStore(root);
    await store.commitReview({ reviewId: "legacy", expectedRevision: 0, knowledgeRevision: 7, decision, now });
    const path = join(root, "proactive.json");
    const persisted = JSON.parse(await readFile(path, "utf8"));
    delete persisted.proposals[0].handoffBrief;
    await writeFile(path, JSON.stringify(persisted));
    expect((await createProactiveStateStore(root).read()).proposals[0]).not.toHaveProperty("handoffBrief");
    persisted.proposals[0].handoffBrief = null;
    await writeFile(path, JSON.stringify(persisted));
    await expect(createProactiveStateStore(root).read()).rejects.toThrow("proactive_handoff_brief_invalid");
    const original = { title: authored.title, content: authored.message, initiative: { kind: "proactive_proposal_v1" as const,
      proposalId: "old-proposal", reason: decision.reason, sources: [source] } };
    expect(() => assertAssistantInitiative(original)).not.toThrow();
    expect(() => assertAssistantInitiative({ ...original, initiative: { ...original.initiative, handoffBrief: "" } }))
      .toThrow("assistant_initiative_handoff_brief_invalid");
    expect(() => assertAssistantInitiative({ ...original, initiative: { ...original.initiative, handoffTitle: "x".repeat(161) } }))
      .toThrow("assistant_initiative_handoff_title_invalid");
  });
});
