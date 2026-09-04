import type {
  RoleCallFrame,
  RoleCallPolicy,
  RoleCallResult,
  RoleCallState,
} from "./contracts.js";
import {
  isRoleCallResultReceiptValidForReturn,
  type RoleCallResultReceipt,
} from "./result-receipt.js";
import {
  createCanonicalRoleCallWorkResultReceipt,
  mustIssueSupervisorWorkResultReceipt,
  ROLE_CALL_WORK_RESULT_RECEIPT_KIND,
} from "./work-result-receipt.js";

export type CanonicalResultReceiptResolution =
  | Readonly<{
      ok: true;
      receipt?: RoleCallResultReceipt;
    }>
  | Readonly<{
      ok: false;
      issueCode:
        | "work_result_receipt_forged"
        | "work_result_lineage_invalid"
        | "result_receipt_invalid";
    }>;

export function resolveCanonicalResultReceiptForReturn(params: Readonly<{
  state: RoleCallState;
  caller: RoleCallFrame;
  child: RoleCallFrame;
  resultRef: string;
  outcome: RoleCallResult["outcome"];
  suppliedReceipt?: RoleCallResultReceipt;
  policy: RoleCallPolicy;
  admittedHeadRevision?: number;
}>): CanonicalResultReceiptResolution {
  if (params.suppliedReceipt?.kind === ROLE_CALL_WORK_RESULT_RECEIPT_KIND) {
    return invalidResolution("work_result_receipt_forged");
  }
  if (
    mustIssueSupervisorWorkResultReceipt({
      child: params.child,
      policy: params.policy,
    })
  ) {
    return resolveRuntimeOwnedWorkReceipt(params);
  }
  if (
    !isRoleCallResultReceiptValidForReturn({
      receipt: params.suppliedReceipt,
      caller: params.caller,
      child: params.child,
      outcome: params.outcome,
      policy: params.policy,
      admittedHeadRevision: params.admittedHeadRevision,
    })
  ) {
    return invalidResolution("result_receipt_invalid");
  }
  return params.suppliedReceipt
    ? Object.freeze({ ok: true, receipt: params.suppliedReceipt })
    : Object.freeze({ ok: true });
}

function resolveRuntimeOwnedWorkReceipt(
  params: Parameters<typeof resolveCanonicalResultReceiptForReturn>[0],
): CanonicalResultReceiptResolution {
  if (params.suppliedReceipt !== undefined) {
    return invalidResolution("work_result_receipt_forged");
  }
  if (!isNonNegativeSafeInteger(params.admittedHeadRevision)) {
    return invalidResolution("work_result_lineage_invalid");
  }
  const receipt = createCanonicalRoleCallWorkResultReceipt({
    state: params.state,
    caller: params.caller,
    child: params.child,
    resultRef: params.resultRef,
    outcome: params.outcome,
    admittedHeadRevision: params.admittedHeadRevision,
    policy: params.policy,
  });
  return receipt
    ? Object.freeze({ ok: true, receipt })
    : invalidResolution("work_result_lineage_invalid");
}

function invalidResolution(
  issueCode: Extract<
    CanonicalResultReceiptResolution,
    { ok: false }
  >["issueCode"],
): CanonicalResultReceiptResolution {
  return Object.freeze({ ok: false, issueCode });
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
