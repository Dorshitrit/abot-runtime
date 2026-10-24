import { expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { buildCheckpointMessage } from "../context/semantic-compaction/checkpoint-message.js";
import { SEMANTIC_COMPACTION_EVIDENCE_SCOPE } from "../context/semantic-compaction/evidence-scope.js";
import { projectCheckpointMessages } from "../context/model-step-compaction-projection.js";
import { buildRequestToolResultsMessage } from "../context/request-tool-results.js";
import { createSemanticCompactionSha256Fingerprint as hash } from "../context/semantic-compaction/contracts.js";
import {
  compactedSourceFixture,
  settledSource,
} from "./support/compacted-execution-source-fixture.js";

const payloadPrefix = "Canonical runtime context:\n";
const intent: ChatMessage = {
  role: "user",
  content: "Accepted replacement objective.",
};

function successor(
  checkpoint: ReturnType<typeof compactedSourceFixture>["checkpoint"],
) {
  return {
    ...checkpoint,
    scopeId: checkpoint.scopeId + ":objective:" + hash(intent.content),
    objectiveFingerprint: hash(intent.content),
    sourceRevision: checkpoint.sourceRevision + 1,
    continuation: {
      ...checkpoint.continuation,
      currentState: "Fresh accepted objective is active.",
      nextStep: "Continue the newly accepted objective.",
    },
  };
}

function carrierFixture(kind: "request" | "payload") {
  const result = settledSource();
  const message: ChatMessage =
    kind === "request"
      ? buildRequestToolResultsMessage({ sourceRevision: 7, results: [result] })
      : {
          role: "user",
          content:
            payloadPrefix +
            JSON.stringify({
              acceptedAssignment: "Preserve the accepted assignment.",
              settledCapabilityResults: [result],
            }),
        };
  const content =
    kind === "request"
      ? JSON.stringify(JSON.parse(message.content).results[0])
      : JSON.stringify(result);
  const source = {
    sourceRef:
      kind === "request"
        ? result.executionId
        : "payload-result:" + result.executionId,
    sourceFingerprint: hash(content),
    content,
  };
  const f = compactedSourceFixture([result], {}, [source]);
  const overrides = new Map([[source.sourceRef, source]]);
  function read(message: ChatMessage) {
    return JSON.parse(
      kind === "request"
        ? message.content
        : message.content.slice(payloadPrefix.length),
    );
  }
  function rewrite(message: ChatMessage, value: unknown): ChatMessage {
    if (message.role !== "user") throw new Error("expected_user_carrier");
    return {
      ...message,
      content:
        (kind === "payload" ? payloadPrefix : "") + JSON.stringify(value),
    };
  }
  return {
    ...f,
    message,
    overrides,
    read,
    rewrite,
    next: successor(f.checkpoint),
  };
}

test("default standalone projection retains the existing serialized continuation contract", () => {
  const { checkpoint } = compactedSourceFixture();
  const expected = JSON.stringify({
    kind: checkpoint.kind,
    evidenceScope: SEMANTIC_COMPACTION_EVIDENCE_SCOPE,
    authority: "runtime_role_continuation",
    presenceEffect: "passive_continuity_not_user_intent_routing_or_completion",
    scopeId: checkpoint.scopeId,
    roleId: checkpoint.roleId,
    callId: checkpoint.callId,
    sourceRevision: checkpoint.sourceRevision,
    coveredSources: checkpoint.sourceDigests,
    continuation: checkpoint.continuation,
  });
  expect(buildCheckpointMessage(checkpoint).content).toBe(expected);
  expect(
    buildCheckpointMessage(checkpoint, {
      includeContinuation: true,
      replacesScopeId: "unused",
    }).content,
  ).toBe(expected);
});

test("standalone inheritance omits old continuation and replacement removes only authorized scopes", () => {
  const f = compactedSourceFixture();
  const next = successor(f.checkpoint);
  const overrides = new Map(
    f.sources.map((source) => [source.sourceRef, source]),
  );
  const raw: ChatMessage = JSON.parse(f.sources[0]!.content);
  const verified = vi.fn();
  const before = JSON.stringify(f.checkpoint);
  const inherited = projectCheckpointMessages(
    [intent, raw],
    next.scopeId,
    f.checkpoint,
    overrides,
    false,
    verified,
    { includeContinuation: false },
  );
  expect(inherited[0]).toBe(intent);
  const capsule = JSON.parse(inherited[1]!.content);
  expect(capsule).toMatchObject({
    scopeId: f.checkpoint.scopeId,
    authority: "passive_source_evidence",
    coveredSources: f.checkpoint.sourceDigests,
  });
  expect(capsule).not.toHaveProperty("continuation");
  expect(JSON.stringify(inherited)).not.toContain(
    f.checkpoint.continuation.nextStep,
  );
  expect(verified).toHaveBeenCalledExactlyOnceWith(inherited[1]);
  const unrelated = buildCheckpointMessage({
    ...f.checkpoint,
    scopeId: "unrelated-scope",
  });
  const replacement = projectCheckpointMessages(
    [...inherited, buildCheckpointMessage(next), unrelated],
    next.scopeId,
    next,
    overrides,
    false,
    undefined,
    { replacesScopeId: f.checkpoint.scopeId },
  );
  expect(replacement[0]).toBe(intent);
  expect(
    replacement.filter(
      ({ content }) => content === buildCheckpointMessage(next).content,
    ),
  ).toHaveLength(1);
  expect(replacement).toContain(unrelated);
  expect(replacement.map(({ content }) => content)).not.toContain(
    inherited[1]!.content,
  );
  expect(JSON.stringify(f.checkpoint)).toBe(before);
});

test.each(["request", "payload"] as const)(
  "%s carrier inherits source-only evidence and replaces it with one genuinely new continuation",
  (kind) => {
    const f = carrierFixture(kind);
    const original = JSON.stringify({
      checkpoint: f.checkpoint,
      source: f.sources[0],
    });
    const verified = vi.fn();
    const inherited = projectCheckpointMessages(
      [intent, f.message],
      f.next.scopeId,
      f.checkpoint,
      f.overrides,
      false,
      verified,
      { includeContinuation: false },
    );
    const capsule = f.read(inherited[1]!).semanticCheckpoint;
    expect(inherited[0]).toBe(intent);
    expect(capsule).toMatchObject({
      scopeId: f.checkpoint.scopeId,
      authority: "passive_source_evidence",
      coveredSources: f.checkpoint.sourceDigests,
    });
    expect(capsule).not.toHaveProperty("continuation");
    expect(capsule.coveredResults[0]).not.toHaveProperty("adapterResult");
    expect(capsule.coveredResults[0]).not.toHaveProperty("referenceData");
    expect(verified).toHaveBeenCalledExactlyOnceWith(inherited[1]);
    const replaced = projectCheckpointMessages(
      inherited,
      f.next.scopeId,
      f.next,
      f.overrides,
      false,
      undefined,
      { replacesScopeId: f.checkpoint.scopeId },
    );
    expect(replaced).toHaveLength(2);
    const nextCapsule = f.read(replaced[1]!).semanticCheckpoint;
    expect(nextCapsule).toMatchObject({
      scopeId: f.next.scopeId,
      continuation: f.next.continuation,
      coveredSources: f.next.sourceDigests,
      coveredResults: capsule.coveredResults,
    });
    expect(nextCapsule).not.toHaveProperty("authority");
    expect(JSON.stringify(replaced)).not.toContain(
      f.checkpoint.continuation.nextStep,
    );
    expect(
      projectCheckpointMessages(replaced, f.next.scopeId, f.next, f.overrides),
    ).toEqual(replaced);
    expect(
      JSON.stringify({ checkpoint: f.checkpoint, source: f.sources[0] }),
    ).toBe(original);
  },
);

test.each(["request", "payload"] as const)(
  "%s carrier rejects an unrelated prior scope and still checks receipts during authorized replacement",
  (kind) => {
    const f = carrierFixture(kind);
    const inherited = projectCheckpointMessages(
      [f.message],
      f.next.scopeId,
      f.checkpoint,
      f.overrides,
      false,
      undefined,
      { includeContinuation: false },
    );
    for (const replacesScopeId of [undefined, "another-scope"]) {
      expect(() =>
        projectCheckpointMessages(
          inherited,
          f.next.scopeId,
          f.next,
          f.overrides,
          false,
          undefined,
          { replacesScopeId },
        ),
      ).toThrow("context_compaction_checkpoint_scope_conflict");
    }
    const forged = f.read(inherited[0]!);
    forged.semanticCheckpoint.coveredResults[0].sourceFingerprint =
      hash("tampered");
    expect(() =>
      projectCheckpointMessages(
        [f.rewrite(inherited[0]!, forged)],
        f.next.scopeId,
        f.next,
        f.overrides,
        false,
        undefined,
        { replacesScopeId: f.checkpoint.scopeId },
      ),
    ).toThrow("context_compaction_checkpoint_receipt_invalid");
  },
);

test.each(["request", "payload"] as const)(
  "%s carrier default and explicit continuation retain identical bytes",
  (kind) => {
    const f = carrierFixture(kind);
    const standard = projectCheckpointMessages(
      [f.message],
      f.checkpoint.scopeId,
      f.checkpoint,
      f.overrides,
    );
    const explicit = projectCheckpointMessages(
      [f.message],
      f.checkpoint.scopeId,
      f.checkpoint,
      f.overrides,
      false,
      undefined,
      { includeContinuation: true },
    );
    expect(explicit).toEqual(standard);
    const projected = f.read(standard[0]!);
    expect(projected.semanticCheckpoint.continuation).toEqual(
      f.checkpoint.continuation,
    );
    expect(projected.semanticCheckpoint).not.toHaveProperty("authority");
  },
);
