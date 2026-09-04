import {
  PLUGIN_RESULT_SERIALIZED_MAX_BYTES,
  successResult,
  type SuccessResultInput,
} from "../../../src/plugin-sdk/index.js";
import type { WebSourcesReceipt } from "./source-receipt-contract.js";

function fitsPluginResultBudget(result: unknown): boolean {
  return (
    Buffer.byteLength(JSON.stringify(result), "utf8") <=
    PLUGIN_RESULT_SERIALIZED_MAX_BYTES
  );
}

function limitReceiptSources(
  receipt: WebSourcesReceipt,
  count: number,
): WebSourcesReceipt {
  const omittedSourceCount =
    (receipt.omittedSourceCount ?? 0) + receipt.sources.length - count;
  return Object.freeze({
    ...receipt,
    sources: Object.freeze(receipt.sources.slice(0, count)),
    ...(omittedSourceCount > 0 ? { omittedSourceCount } : {}),
  });
}

/** Optional UI metadata must never turn an existing successful result into a failure. */
export function successWithSourceReceipts(
  input: SuccessResultInput,
  receipt: WebSourcesReceipt,
) {
  const baseline = successResult(input);
  if (!baseline.ok) return baseline;
  for (let count = receipt.sources.length; count >= 0; count -= 1) {
    const candidate = {
      ...baseline,
      data: {
        ...baseline.data,
        eventMeta: {
          ...(baseline.data?.eventMeta as
            | Readonly<Record<string, unknown>>
            | undefined),
          webSources: limitReceiptSources(receipt, count),
        },
      },
    };
    if (fitsPluginResultBudget(candidate)) return Object.freeze(candidate);
  }
  return baseline;
}
