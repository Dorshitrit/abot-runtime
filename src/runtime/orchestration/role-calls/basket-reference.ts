import type { BasketReadResult, BasketSearchResult } from "../../information-basket/contracts.js";
import type { BasketReferenceSelection } from "./basket-reference-selection.js";
import { basketReferenceSelection } from "./basket-reference-selection.js";
import { exactKeys, isRecord } from "../../validation/strict-record.js";
import { isBasketReferenceResult } from "./basket-reference-result.js";
import type { RoleCallPolicy, RoleCallState, RoleCallValidationIssue } from "./contracts.js";

export type BasketReferenceResult =
  | Readonly<{ outcome: "completed"; data: BasketReadResult | BasketSearchResult }>
  | Readonly<{ outcome: "failed"; errorCode: string }>;
export type BasketReferencePayload = Readonly<{
  selection: BasketReferenceSelection;
  result: BasketReferenceResult;
}>;
type BasketReferenceBinding = Readonly<{ callId: string; invocationAttempt: number; steeringVersion: number }>;
export type RoleBasketReference = BasketReferenceBinding & BasketReferencePayload & Readonly<{ referenceId: string }>;
/** Omission keeps requests created before basket support unchanged. */
export function validateRoleBasketReferences(state: RoleCallState, policy: RoleCallPolicy): readonly RoleCallValidationIssue[] {
  const records = state.basketReferences;
  if (records === undefined) return [];
  const invalid = [{ code: "invalid_basket_references", path: "state.basketReferences" }];
  if (!Array.isArray(records)) return invalid;
  if (records.length === 0) return [];
  if (policy.authority.rootContractId !== "supervisor") return invalid;
  const root = state.calls.find(({ callId }) => callId === state.rootCallId);
  if (!root || root.parentCallId !== null || root.roleId !== "supervisor") return invalid;
  let previousAttempt = 0;
  let previousSteering = 0;
  for (const [index, record] of records.entries()) {
    if (!isRecord(record)) return invalid;
    if (!exactKeys(record, ["referenceId", "callId", "invocationAttempt", "steeringVersion", "selection", "result"])) return invalid;
    if (!hasBasketReferencePayload(record)) return invalid;
    if (record.referenceId !== "basket-reference-" + (index + 1)) return invalid;
    if (record.callId !== root.callId) return invalid;
    if (record.invocationAttempt <= previousAttempt || record.invocationAttempt >= root.activationCount) return invalid;
    if (record.steeringVersion < previousSteering) return invalid;
    previousAttempt = record.invocationAttempt;
    previousSteering = record.steeringVersion;
  }
  return [];
}

function hasBasketReferencePayload(input: Record<string, unknown>): input is Record<string, unknown> & BasketReferenceBinding {
  if (typeof input.callId !== "string" || input.callId.length === 0) return false;
  if (!Number.isSafeInteger(input.invocationAttempt) || (input.invocationAttempt as number) < 1) return false;
  if (!Number.isSafeInteger(input.steeringVersion) || (input.steeringVersion as number) < 0) return false;
  const selection = basketReferenceSelection(input.selection);
  if (!selection || !isRecord(input.selection) || !exactKeys(input.selection, Object.keys(selection))) return false;
  return isBasketReferenceResult(input.result, selection);
}
