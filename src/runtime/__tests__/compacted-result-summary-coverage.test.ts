import { expect, test } from "vitest";
import { projectExecutionPayloadCompactedEvidence } from "../request/execution-payload-compacted-evidence.js";
import {
  compactedSourceFixture,
  payloadSourceContext,
  settledSource,
} from "./support/compacted-execution-source-fixture.js";

const cases = [
  { output: "Done", summary: "Done", covered: true },
  { output: "\nDone\n", summary: "\nDone\n", covered: true },
  { output: "\nDone\n", summary: "Done", covered: false },
  { output: "Done", summary: "\nDone\n", covered: false },
  { output: " Done", summary: "Done", covered: false },
  { output: "Done\t", summary: "Done", covered: false },
  { output: "Done", summary: "done", covered: false },
  { output: "Done", summary: "Independent finding", covered: false },
];

test.each(cases)(
  "summary coverage is exact for $output / $summary",
  ({ output, summary, covered }) => {
    const result = settledSource("execution-1", "INDEPENDENT_REFERENCE");
    if (result.adapterResult?.kind !== "registered_tool_execution_result_v1")
      throw new Error("fixture must provide registered output");
    const source = {
      ...result,
      summary,
      adapterResult: {
        ...result.adapterResult,
        result: { ...result.adapterResult.result, output },
      },
    };
    const before = JSON.stringify(source);
    const f = compactedSourceFixture([source]);
    const projection = projectExecutionPayloadCompactedEvidence(
      f.request,
      payloadSourceContext(f.results),
      f.results,
    );
    const receipt = projection.results[0]!;
    expect(receipt).not.toHaveProperty("adapterResult");
    expect(receipt).toMatchObject({
      compactedSourceRef: "tool-result:execution-1",
      referenceData: "INDEPENDENT_REFERENCE",
    });
    if (covered) expect(receipt.summary).not.toBe(summary);
    else expect(receipt.summary).toBe(summary);
    expect(projection.evidence?.sources[0]?.digest).toBe("DIGEST_execution-1");
    expect(JSON.stringify(source)).toBe(before);
  },
);

test("fresh output cannot borrow a previous output's compacted summary coverage", () => {
  const f = compactedSourceFixture();
  const result = f.results[0]!;
  if (result.adapterResult?.kind !== "registered_tool_execution_result_v1")
    throw new Error("fixture must provide registered output");
  const fresh = {
    ...result,
    summary: "New result",
    adapterResult: {
      ...result.adapterResult,
      result: { ...result.adapterResult.result, output: "New result" },
    },
  };
  const projection = projectExecutionPayloadCompactedEvidence(
    f.request,
    payloadSourceContext([fresh]),
    [fresh],
  );
  expect(projection.results[0]).toBe(fresh);
  expect(projection.evidence).toBeUndefined();
});
