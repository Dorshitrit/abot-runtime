import {
  resolveRoleCallTransactions,
  type RoleCallFrame,
  type RoleCallLedger,
  type RoleCallLedgerHead,
} from "../orchestration/role-calls/index.js";
import type { RoleMemoryRecallResult } from "../orchestration/role-calls/memory-recall-contract.js";
import {
  boundMemoryRecallResult,
  unavailableMemoryRecall,
} from "../long-term-memory/recall-result.js";
import { classifyMemoryFailure } from "../long-term-memory/diagnostics.js";
import type { RequestExecutionScope } from "./execution-scope.js";
import { resolveRequestSteeringInbox } from "./request-steering.js";

/** One service invocation, one canonical settlement, then the existing root loop resumes. */
export async function performRootMemoryRecall(params: {
  request: RequestExecutionScope;
  ledger: RoleCallLedger;
  head: RoleCallLedgerHead;
  call: RoleCallFrame;
  steeringVersion: number;
  query: string;
}): Promise<void> {
  const { request } = params;
  const steering = resolveRequestSteeringInbox(request.requestSteering);
  request.abortSignal.throwIfAborted();
  if (!steering.isCurrent(params.steeringVersion)) return;
  if (request.longTermMemory?.enabled !== true) {
    throw new Error("memory_recall_not_available");
  }
  const transactions = resolveRoleCallTransactions(params.ledger);
  const started = await transactions.beginMemoryRecall({
    expectedHead: params.head,
    callId: params.call.callId,
    invocationAttempt: params.call.activationCount,
    steeringVersion: params.steeringVersion,
    query: params.query,
  });
  if (!started.ok) {
    throw new Error(`role_call_ledger_rejected:${started.issueCode}`);
  }
  request.abortSignal.throwIfAborted();
  const retrieved = steering.isCurrent(params.steeringVersion)
    ? await retrieveRootMemory(params)
    : supersededMemoryRecall();
  request.abortSignal.throwIfAborted();
  const result: RoleMemoryRecallResult = steering.isCurrent(
    params.steeringVersion,
  )
    ? retrieved
    : supersededMemoryRecall();
  const settled = await transactions.settleMemoryRecall({
    expectedHead: started.commit.head,
    callId: params.call.callId,
    recallId: started.commit.effect.recallId,
    invocationAttempt: params.call.activationCount,
    steeringVersion: params.steeringVersion,
    result,
  });
  if (!settled.ok) {
    throw new Error(`role_call_ledger_rejected:${settled.issueCode}`);
  }
}

async function retrieveRootMemory(
  params: Parameters<typeof performRootMemoryRecall>[0],
): Promise<RoleMemoryRecallResult> {
  const { request } = params;
  try {
    return boundMemoryRecallResult(
      await request.longTermMemory!.retrieve({
        query: params.query,
        context: {
          requestId: request.requestId,
          sessionId: request.sessionId,
          abortSignal: request.abortSignal,
          onEvent: request.onEvent,
        },
      }),
    );
  } catch (error) {
    if (request.abortSignal.aborted) throw error;
    return unavailableMemoryRecall(classifyMemoryFailure(error));
  }
}

function supersededMemoryRecall(): RoleMemoryRecallResult {
  return Object.freeze({
    outcome: "superseded",
    records: Object.freeze([]),
    omittedRecordCount: 0,
  });
}
