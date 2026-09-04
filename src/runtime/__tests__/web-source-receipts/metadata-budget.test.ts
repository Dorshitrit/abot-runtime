import { describe, expect, test } from "vitest";

import {
  PLUGIN_RESULT_SERIALIZED_MAX_BYTES,
  successResult,
  type SuccessResultInput,
} from "../../../plugin-sdk/index.js";
import { successWithSourceReceipts } from "../../../../plugins/web/source/source-receipt-budget.js";
import type { WebSourcesReceipt } from "../../../../plugins/web/source/source-receipt-contract.js";

function inputWithBytes(bytes: number): SuccessResultInput {
  const input = {
    output: "Unchanged tool evidence.",
    progress: true,
    producedNewInformation: false,
    data: {
      itemCount: 5,
      eventMeta: {
        urls: ["https://source.example/a"],
        coverage: { outputTruncated: true },
      },
      padding: "",
    },
  };
  const baseBytes = Buffer.byteLength(
    JSON.stringify(successResult(input)),
    "utf8",
  );
  return {
    ...input,
    data: { ...input.data, padding: "x".repeat(bytes - baseBytes) },
  };
}

function receipt(): WebSourcesReceipt {
  return {
    version: 1,
    operation: "search",
    provider: "brave",
    sources: Array.from({ length: 5 }, (_, index) => ({
      url: `https://source.example/${index}/${"x".repeat(2000)}`,
      title: `Title ${index}`,
      retrieval: "retrieved",
      presentation: "content",
      contentTruncated: false,
    })),
  };
}

describe("optional source receipt byte budget", () => {
  test("keeps original output, SDK flags and metadata when adding complete receipts", () => {
    const input = inputWithBytes(1000);
    const baseline = successResult(input);
    const result = successWithSourceReceipts(input, receipt());
    const eventMeta = result.data?.eventMeta as Record<string, unknown>;
    const { webSources, ...legacyMetadata } = eventMeta;
    expect({
      ...result,
      data: { ...result.data, eventMeta: legacyMetadata },
    }).toEqual(baseline);
    expect(webSources).toEqual(receipt());
    expect(input.data?.eventMeta).not.toHaveProperty("webSources");
  });

  test("removes last receipt entries and reports exactly how many metadata entries were omitted", () => {
    const input = inputWithBytes(127_500);
    const result = successWithSourceReceipts(input, receipt());
    const webSources = (
      result.data?.eventMeta as { webSources: WebSourcesReceipt }
    ).webSources;
    expect(result.ok).toBe(true);
    expect(webSources.sources).toEqual(receipt().sources.slice(0, 1));
    expect(webSources.omittedSourceCount).toBe(4);
    expect(webSources.sources[0]?.presentation).toBe("content");
    expect(
      Buffer.byteLength(JSON.stringify(result), "utf8"),
    ).toBeLessThanOrEqual(PLUGIN_RESULT_SERIALIZED_MAX_BYTES);
    expect(result.output).toBe(input.output);
  });

  test("preserves prior omission counts when the envelope requires further trimming", () => {
    const result = successWithSourceReceipts(inputWithBytes(127_500), {
      ...receipt(),
      omittedSourceCount: 2,
    });
    const webSources = (
      result.data?.eventMeta as { webSources: WebSourcesReceipt }
    ).webSources;
    expect(webSources.omittedSourceCount).toBe(6);
    expect(Number.isSafeInteger(webSources.omittedSourceCount)).toBe(true);
  });

  test("can report an entirely omitted receipt list while preserving success", () => {
    const result = successWithSourceReceipts(
      inputWithBytes(130_500),
      receipt(),
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        eventMeta: { webSources: { sources: [], omittedSourceCount: 5 } },
      },
    });
  });

  test("returns the exact baseline if even an empty receipt cannot fit", () => {
    const input = inputWithBytes(PLUGIN_RESULT_SERIALIZED_MAX_BYTES - 1);
    expect(successWithSourceReceipts(input, receipt())).toEqual(
      successResult(input),
    );
    expect(
      successWithSourceReceipts(input, receipt()).data?.eventMeta,
    ).not.toHaveProperty("webSources");
  });

  test("preserves an existing SDK size failure without adding receipt metadata", () => {
    const input = inputWithBytes(PLUGIN_RESULT_SERIALIZED_MAX_BYTES + 1);
    const result = successWithSourceReceipts(input, receipt());
    expect(result).toEqual(successResult(input));
    expect(result).toMatchObject({
      ok: false,
      errorCode: "plugin_result_too_large",
    });
  });
});
