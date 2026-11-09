import type { RegisteredToolNormalInvocationResult } from "../../adapters/registered-tool-normal-invocations/shared/contracts.js";
import type { SparkHomeEvidence, SparkHomeReadSelection } from "./contracts.js";

const HOME_RECEIPT_CHARACTERS = 6000;

/** Only settled executor output becomes evidence. Omission is explicit and never a success assertion. */
export function projectSparkHomeEvidence(selection: SparkHomeReadSelection, fingerprint: string,
  result: RegisteredToolNormalInvocationResult): SparkHomeEvidence {
  if (result.status === "rejected") return { operation: selection.operation, purpose: selection.purpose,
    actionFingerprint: fingerprint, outcome: "rejected", output: result.message.slice(0, HOME_RECEIPT_CHARACTERS),
    omittedCharacters: Math.max(0, result.message.length - HOME_RECEIPT_CHARACTERS), errorCode: result.code };
  const receipt = JSON.stringify({ output: result.result.output, ...(result.result.data ? { data: result.result.data } : {}),
    ...(result.result.errorCode ? { errorCode: result.result.errorCode } : {}) });
  return { operation: selection.operation, purpose: selection.purpose, actionFingerprint: fingerprint,
    outcome: result.result.ok ? "succeeded" : "failed", output: receipt.slice(0, HOME_RECEIPT_CHARACTERS),
    omittedCharacters: Math.max(0, receipt.length - HOME_RECEIPT_CHARACTERS),
    ...(result.result.errorCode ? { errorCode: result.result.errorCode } : {}) };
}
