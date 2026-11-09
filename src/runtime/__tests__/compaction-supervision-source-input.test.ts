import { expect, test } from "vitest";
import { projectCompactionSourceInput } from "../context/compaction-source-input.js";
import {
  createSemanticCompactionSha256Fingerprint as hash,
  type SemanticCompactionSource,
} from "../context/semantic-compaction/contracts.js";
import { createRequestContextCompactionStore } from "../context/semantic-compaction/store.js";
import {
  captureRequestContextCompaction,
  restoreRequestContextCompaction,
} from "../context/semantic-compaction/snapshot.js";

function fixture(
  kind = "embedded_cross_call_exact_result",
  referenceData = "observed evidence",
) {
  const output = "  observed evidence\n";
  const receipt = {
    executionId: "execution-1",
    callId: "worker-1",
    invocationAttempt: 1,
    capabilityId: "read",
    declaredEffect: "observation",
    outcome: "succeeded",
    observedEffect: "observation",
    summary: "Read the source.",
    referenceData,
    references: [{ kind: "tool_target", target: "input.txt" }],
  };
  const adapterResult = {
    kind: "registered_tool_execution_result_v1",
    authority: "registered_plugin",
    status: "executed",
    result: {
      ok: true,
      tool: "read",
      output,
      producedNewInformation: true,
      data: { label: "keep" },
    },
  };
  const entry = {
    originExecutionId: "execution-1",
    notice: { purpose: "preserve the notice" },
    evidence: {
      kind,
      acceptedAction: { intent: "read the selected source" },
      receipt,
      adapterResult,
    },
  };
  const record = {
    kind: "runtime_operation_supervision_evidence_v1",
    authority: "canonical_role_call_ledger",
    sourceRevision: 3,
    binding: { callId: "worker-2", invocationAttempt: 2 },
    entries: [entry],
    extraMetadata: { retained: true },
  };
  return { output, entry, record, source: sourceForRecord(record) };
}

function sourceForRecord(
  record: unknown,
  prefix = "operation-supervision-evidence",
): SemanticCompactionSource {
  const message = { role: "user", content: JSON.stringify(record) };
  const content = JSON.stringify(message);
  return {
    sourceRef: `${prefix}:${hash(message.content).slice(7)}`,
    sourceFingerprint: hash(content),
    content,
  };
}

function readView(source: SemanticCompactionSource) {
  return JSON.parse(JSON.parse(source.content).content);
}

test.each(["embedded_exact_result", "embedded_cross_call_exact_result"])(
  "%s omits the normalized alias and preserves the exact result and all other evidence",
  (kind) => {
    const f = fixture(kind);
    const view = projectCompactionSourceInput(f.source);
    const { referenceData: _alias, ...singleCopy } = f.entry.evidence.receipt;
    expect(readView(view)).toEqual({
      ...f.record,
      entries: [
        { ...f.entry, evidence: { ...f.entry.evidence, receipt: singleCopy } },
      ],
    });
    expect(readView(view).entries[0].evidence.adapterResult.result.output).toBe(
      f.output,
    );
    expect(view.sourceRef).toBe(f.source.sourceRef);
    expect(view.sourceFingerprint).toBe(hash(view.content));
    expect(view.sourceFingerprint).not.toBe(f.source.sourceFingerprint);
    expect(f.source).toEqual(sourceForRecord(f.record));
    expect(projectCompactionSourceInput(view)).toBe(view);
  },
);

test("an exact alias is removed without touching the original whitespace", () => {
  const f = fixture(
    "embedded_cross_call_exact_result",
    "  observed evidence\n",
  );
  const evidence = readView(projectCompactionSourceInput(f.source)).entries[0]
    .evidence;
  expect(evidence.receipt).not.toHaveProperty("referenceData");
  expect(evidence.adapterResult).toEqual(f.entry.evidence.adapterResult);
});

test("supplementary and unknown receipts are unchanged", () => {
  const f = fixture();
  const cases = [
    fixture("embedded_cross_call_exact_result", "supplementary evidence")
      .source,
    fixture("unknown_evidence_kind").source,
    sourceForRecord({
      ...f.record,
      entries: [{ ...f.entry, originExecutionId: "another-execution" }],
    }),
    sourceForRecord({
      ...f.record,
      entries: [
        {
          ...f.entry,
          evidence: {
            ...f.entry.evidence,
            receipt: { ...f.entry.evidence.receipt, unknownField: true },
          },
        },
      ],
    }),
  ];
  for (const source of cases)
    expect(projectCompactionSourceInput(source)).toBe(source);
});

test("source identity and known wrapper are required; literal lookalikes remain text", () => {
  const f = fixture();
  const cases = [
    {
      ...f.source,
      sourceRef: `operation-supervision-evidence:${hash("another source").slice(7)}`,
    },
    sourceForRecord(f.record, "other-source"),
    sourceForRecord({ ...f.record, kind: "example_from_user" }),
    sourceForRecord({ ...f.record, authority: "user" }),
    sourceForRecord({ userDocument: f.record }),
    sourceForRecord(JSON.stringify(f.record)),
  ];
  for (const source of cases)
    expect(projectCompactionSourceInput(source)).toBe(source);
});

test("saved supervision sources remain byte-identical and restorable", () => {
  const f = fixture();
  const store = createRequestContextCompactionStore();
  store.registerSources([f.source]);
  const before = captureRequestContextCompaction(store);
  const view = projectCompactionSourceInput(f.source);
  expect(captureRequestContextCompaction(store)).toEqual(before);
  const restored = restoreRequestContextCompaction(before);
  expect(
    restored.materializeSource(f.source.sourceRef, f.source.sourceFingerprint),
  ).toEqual(f.source);
  expect(
    restored.materializeSource(view.sourceRef, view.sourceFingerprint),
  ).toBeUndefined();
});
