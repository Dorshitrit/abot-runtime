import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { decodeProactiveModelDecision } from "../passive-learning/proactive/model-output.js";
import { validateProactiveDecision, type ProactiveReviewInput } from "../passive-learning/proactive/contracts.js";
import * as logger from "../observability/debug-logger.js";

const now = Date.parse("2026-09-25T12:00:00Z");
const source = { kind: "candidate" as const, id: "private-source", version: "1" };
const input: ProactiveReviewInput = { reviewId: "test-review", modelProfileId: "model", signal: new AbortController().signal,
  recentProposals: [], context: { kind: "learning_knowledge_reference_v1", authority: "passive_reference",
    presenceEffect: "does_not_authorize_actions_or_add_user_intent", repositoryRevision: 1, knowledgeRevision: 1,
    referenceTime: new Date(now).toISOString(), omitted: 0, entries: [{ ...source, content: "private-knowledge",
      tags: [], score: 40, reason: "private-reason", certainty: "inferred", mutable: true,
      lastReinforcedAt: null, reconsiderAt: null }] } };
const none = { kind: "none", title: null, message: null, sources: [], expiresAt: null, reconsiderAt: null };
const proposal = { kind: "proposal", title: "private-title", message: "private-message", sources: [source],
  expiresAt: new Date(now + 3600000).toISOString(), reconsiderAt: null };
beforeEach(() => { vi.spyOn(logger, "traceDebug").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe("optional proactive explanation", () => {
  test.each([
    [undefined, "omitted"], [null, "omitted"], ["", "empty"], ["  \n ", "empty"],
    [42, "invalid_type"], [{ secret: "private-output" }, "invalid_type"],
  ])("accepts otherwise valid decisions with reason %j without fabricating evidence", (reason, reasonState) => {
    for (const raw of [none, proposal]) {
      const decision = decodeProactiveModelDecision(JSON.stringify({ ...raw, reason }), input);
      expect(decision).toMatchObject(raw);
      expect(decision.reason).toContain("No explanation provided");
      expect(() => validateProactiveDecision(decision, input.context.entries, now)).not.toThrow();
      expect(logger.traceDebug).toHaveBeenLastCalledWith("runtime.passive_learning", "proactive.output_accepted",
        expect.objectContaining({ requestId: "proactive:test-review", kind: raw.kind, reasonState }));
    }
    expect(JSON.stringify(vi.mocked(logger.traceDebug).mock.calls)).not.toContain("private-");
  });

  test("bounds a supplied explanation locally and preserves its text within the limit", () => {
    const decision = decodeProactiveModelDecision(JSON.stringify({ ...proposal, reason: "x".repeat(1001) }), input);
    expect(decision.reason).toBe("x".repeat(1000));
    expect(logger.traceDebug).toHaveBeenLastCalledWith("runtime.passive_learning", "proactive.output_accepted",
      expect.objectContaining({ reasonState: "truncated", reasonCharacters: 1001 }));
    expect(decodeProactiveModelDecision(JSON.stringify({ ...proposal, reason: " A supplied explanation " }), input).reason)
      .toBe("A supplied explanation");
  });

  test.each([
    [{ ...proposal, sources: [{ ...source, version: "old" }] }, "proactive_source_stale_or_unknown"],
    [{ ...proposal, message: "" }, "proactive_message_invalid"],
    [{ ...proposal, expiresAt: null }, "proactive_expiry_required"],
    [{ ...proposal, expiresAt: new Date(now - 1).toISOString() }, "proactive_time_not_future"],
    [{ ...none, message: "private-message" }, "proactive_none_payload_invalid"],
  ])("keeps delivery safeguards when explanation is absent", (raw, code) => {
    expect(() => decodeProactiveModelDecision(JSON.stringify(raw), input)).toThrow(code);
    expect(logger.traceDebug).toHaveBeenLastCalledWith("runtime.passive_learning", "proactive.output_rejected",
      expect.objectContaining({ reason: code, reasonState: "omitted" }));
    expect(JSON.stringify(vi.mocked(logger.traceDebug).mock.calls)).not.toContain("private-");
  });

  test("keeps persisted canonical decisions strict and rejects malformed model JSON", () => {
    expect(() => validateProactiveDecision({ ...proposal, reason: null }, input.context.entries, now))
      .toThrow("proactive_reason_invalid");
    expect(() => decodeProactiveModelDecision("private-invalid-json", input)).toThrow("proactive_output_invalid_json");
  });
});
