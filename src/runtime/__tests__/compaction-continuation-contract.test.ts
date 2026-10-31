import { expect, test } from "vitest";
import { isValidSemanticCompactionContinuation } from "../context/semantic-compaction/continuation-contract.js";
import { createSuperContinuation } from "../context/super-compaction/continuation.js";
import { parseSemanticCompactionOutput } from "../context/semantic-compaction/parser.js";
import { createSemanticCompactionFormat } from "../context/semantic-compaction/format.js";
import {
  createSemanticCompactionSha256Fingerprint as hash,
  type SemanticCompactionContinuation,
} from "../context/semantic-compaction/contracts.js";
import { bindSemanticCompactionSourceSlots } from "../context/semantic-compaction/source-slots.js";

function structured(currentState: string) {
  const { format, ...value } = createSuperContinuation(currentState);
  void format;
  return value;
}

const sources = [{ sourceRef: "receipt", sourceFingerprint: hash("observed") }];
const sourceDigests = Object.fromEntries(
  bindSemanticCompactionSourceSlots(sources).map(({ sourceKey }) => [
    sourceKey,
    "Observed receipt.",
  ]),
);
function parse(continuation: unknown) {
  return parseSemanticCompactionOutput(
    JSON.stringify({ continuation, sourceDigests }),
    sources,
  );
}

test("structured model output retains its field limits and cannot opt into RAW storage", () => {
  expect(parse(structured("x".repeat(2_000))).ok).toBe(true);
  expect(parse(structured("x".repeat(2_001)))).toEqual({
    ok: false,
    issueCode: "context_compaction_continuation_invalid",
  });
  expect(parse(createSuperContinuation("short"))).toEqual({
    ok: false,
    issueCode: "context_compaction_output_shape_invalid",
  });
  const format = createSemanticCompactionFormat(sources, 4_800);
  expect(format.schema).toMatchObject({
    properties: {
      continuation: {
        additionalProperties: false,
        properties: { currentState: { maxLength: 2_000 } },
      },
    },
  });
});

test.each([
  { currentState: "" },
  { currentState: " untrimmed" },
  { currentState: 42 },
  { format: "unknown" },
  { format: null },
  { nextStep: "x".repeat(2_001) },
  { findings: ["x".repeat(2_001)] },
  { blockers: Array(25).fill("blocked") },
  { completed: null },
])("RAW storage still rejects malformed continuation %j", (change) => {
  const continuation = {
    ...createSuperContinuation("x".repeat(2_119)),
    ...change,
  };
  expect(
    isValidSemanticCompactionContinuation(
      continuation as SemanticCompactionContinuation,
    ),
  ).toBe(false);
});

test("the persisted format distinguishes full RAW handoffs from bounded structured fields", () => {
  expect(
    isValidSemanticCompactionContinuation(
      createSuperContinuation("x".repeat(2_119)),
    ),
  ).toBe(true);
  expect(
    isValidSemanticCompactionContinuation(structured("x".repeat(2_119))),
  ).toBe(false);
  expect(
    isValidSemanticCompactionContinuation(structured("x".repeat(2_000))),
  ).toBe(true);
});
