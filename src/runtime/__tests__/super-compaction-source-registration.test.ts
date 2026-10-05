import { expect, test } from "vitest";

import {
  createRequestContextCompactionStore,
  createSemanticCompactionSha256Fingerprint,
  type SemanticCompactionSource,
} from "../context/semantic-compaction/index.js";

function source(sourceRef: string, content: string): SemanticCompactionSource {
  return {
    sourceRef,
    content,
    sourceFingerprint: createSemanticCompactionSha256Fingerprint(content),
  };
}

test("SUPER rejects a conflicting source batch without registering its prefix", () => {
  const store = createRequestContextCompactionStore();
  const original = source("execution-1", "original");
  const added = source("execution-2", "new evidence");
  store.registerSources([original]);
  expect(() =>
    store.registerSourcesAtomically!([added, source("execution-1", "changed")]),
  ).toThrow("context_compaction_source_identity_conflict");
  expect(store.snapshot!().sources).toEqual([original]);
});

test("SUPER rejects conflicting duplicates and invalid hashes atomically", () => {
  const store = createRequestContextCompactionStore();
  const original = source("execution-1", "original");
  expect(() =>
    store.registerSourcesAtomically!([
      original,
      source("execution-1", "changed"),
    ]),
  ).toThrow("context_compaction_source_identity_conflict");
  expect(store.snapshot!().sources).toEqual([]);
  expect(() =>
    store.registerSourcesAtomically!([
      original,
      { ...source("execution-2", "valid"), content: "corrupt" },
    ]),
  ).toThrow("context_compaction_source_invalid");
  expect(store.snapshot!().sources).toEqual([]);
});

test("same immutable SUPER source is idempotent and request-local", () => {
  const first = createRequestContextCompactionStore();
  const second = createRequestContextCompactionStore();
  const original = source("execution-1", "original");
  first.registerSourcesAtomically!([original, { ...original }]);
  first.registerSourcesAtomically!([original]);
  second.registerSourcesAtomically!([source("execution-1", "another request")]);
  expect(first.snapshot!().sources).toEqual([original]);
  expect(first.snapshot!().checkpoints).toEqual([]);
  expect(second.snapshot!().sources[0]!.content).toBe("another request");
});

test("default registration keeps its existing incremental semantics", () => {
  const store = createRequestContextCompactionStore();
  const original = source("execution-1", "original");
  expect(() =>
    store.registerSources([original, source("execution-1", "changed")]),
  ).toThrow("context_compaction_source_identity_conflict");
  expect(store.snapshot!().sources).toEqual([original]);
});
