import { expect, test } from "vitest";
import {
  createSemanticCompactionSha256Fingerprint as hash,
  parseSemanticCompactionOutput,
} from "../context/semantic-compaction/index.js";
import { compactContinuation } from "./support/semantic-compaction-contract-fixture.js";
import { createSemanticCompactionFormat } from "../context/semantic-compaction/format.js";
import {
  projectOllamaFormat,
  projectOpenAIResponsesFormat,
} from "../../model-gateway/structured-output/projection.js";

const sources = [
  { sourceRef: "tool-action:page-zero", sourceFingerprint: hash("offset=0") },
  { sourceRef: "tool-result:page-zero", sourceFingerprint: hash("page zero") },
  { sourceRef: "tool-action:page-fifty", sourceFingerprint: hash("offset=50") },
  {
    sourceRef: "tool-result:page-fifty",
    sourceFingerprint: hash("page fifty"),
  },
];

test("G01: source slots bind out-of-order JSON properties to canonical identities", () => {
  const continuation = compactContinuation();
  const parsed = parseSemanticCompactionOutput(
    JSON.stringify({
      continuation,
      sourceDigests: {
        source_3: "Page fifty returned nextOffset=null.",
        source_1: "Page zero returned nextOffset=50.",
        source_0: "Accepted browse offset=0.",
        source_2: "Accepted browse offset=50.",
      },
    }),
    sources,
  );
  expect(parsed).toEqual({
    ok: true,
    continuation,
    sourceDigests: sources.map((source, index) => ({
      ...source,
      digest: [
        "Accepted browse offset=0.",
        "Page zero returned nextOffset=50.",
        "Accepted browse offset=50.",
        "Page fifty returned nextOffset=null.",
      ][index],
    })),
  });
});

test("G02: the old positional generation response is rejected", () => {
  const parsed = parseSemanticCompactionOutput(
    JSON.stringify({
      continuation: compactContinuation(),
      sourceDigests: ["action zero", "page zero", "action fifty", "page fifty"],
    }),
    sources,
  );
  expect(parsed).toEqual({
    ok: false,
    issueCode: "context_compaction_sources_invalid",
  });
});

test.each([
  ["missing", { source_0: "A", source_1: "B", source_2: "C" }],
  ["unknown", { source_0: "A", source_1: "B", source_2: "C", source_4: "D" }],
  [
    "extra",
    {
      source_0: "A",
      source_1: "B",
      source_2: "C",
      source_3: "D",
      source_4: "E",
    },
  ],
  ["null", null],
])("G02: rejects %s source slots", (_label, sourceDigests) => {
  expect(
    parseSemanticCompactionOutput(
      JSON.stringify({
        continuation: compactContinuation(),
        sourceDigests,
      }),
      sources,
    ),
  ).toEqual({ ok: false, issueCode: "context_compaction_sources_invalid" });
});

test.each([
  ["object", { digest: "a" }, "context_compaction_source_invalid"],
  ["empty", "  ", "context_compaction_digest_empty"],
  [
    "fingerprint",
    sources[0]!.sourceFingerprint,
    "context_compaction_digest_not_semantic",
  ],
])("G02: rejects %s slot values", (_label, digest, issueCode) => {
  expect(
    parseSemanticCompactionOutput(
      JSON.stringify({
        continuation: compactContinuation(),
        sourceDigests: { source_0: digest },
      }),
      [sources[0]!],
    ),
  ).toEqual({ ok: false, issueCode });
});

test.each([
  ["one long digest", ["long evidence ".repeat(1000).trim()]],
  [
    "uneven allocation",
    ["a".repeat(9000), "brief fact", "third fact", "fourth fact"],
  ],
])("G03: parser preserves %s without a character quota", (_label, digests) => {
  const expected = sources.slice(0, digests.length);
  const result = parseSemanticCompactionOutput(
    JSON.stringify({
      continuation: compactContinuation(),
      sourceDigests: Object.fromEntries(
        digests.map((digest, index) => [`source_${index}`, digest]),
      ),
    }),
    expected,
  );
  expect(result).toEqual({
    ok: true,
    continuation: compactContinuation(),
    sourceDigests: expected.map((source, index) => ({
      ...source,
      digest: digests[index],
    })),
  });
});

test("G07: keyed provider schemas preserve exact keys and valid post-validation paths", () => {
  const canonical = createSemanticCompactionFormat(sources, 100);
  const original = structuredClone(canonical);
  const openai = projectOpenAIResponsesFormat(canonical);
  const ollama = projectOllamaFormat(canonical);
  const keys = ["source_0", "source_1", "source_2", "source_3"];
  expect(openai.format).toMatchObject({
    schema: {
      properties: {
        sourceDigests: {
          type: "object",
          required: keys,
          additionalProperties: false,
          properties: {
            source_0: { type: "string", minLength: 1 },
          },
        },
      },
    },
  });
  expect(ollama.format).toMatchObject({
    properties: {
      sourceDigests: {
        type: "object",
        required: keys,
        additionalProperties: false,
        properties: { source_0: { type: "string", minLength: 1 } },
      },
    },
  });
  expect(
    ollama.diagnostics.filter(({ path }) => path.includes("sourceDigests")),
  ).toEqual([]);
  for (const schema of [
    canonical.schema,
    openai.format?.schema,
    ollama.format,
  ]) {
    const projected = schema as {
      properties: { sourceDigests: { properties: Record<string, unknown> } };
    };
    for (const key of keys)
      expect(
        projected.properties.sourceDigests.properties[key],
      ).not.toHaveProperty("maxLength");
  }
  expect(canonical).toEqual(original);
});
