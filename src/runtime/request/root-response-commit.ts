import type {
  RoleCallLedgerHead,
  RoleCallTransactions,
} from "../orchestration/role-calls/index.js";

export async function commitSupervisorResponse(params: {
  transactions: RoleCallTransactions;
  expectedHead: RoleCallLedgerHead;
  callId: string;
  response: string;
}): Promise<string> {
  const committed = await params.transactions.completeRootResponse({
    expectedHead: params.expectedHead,
    callId: params.callId,
    response: params.response,
  });
  if (!committed.ok) {
    throw new Error(`role_call_ledger_rejected:${committed.issueCode}`);
  }
  const output = committed.commit.head.state.rootResponse;
  if (!output) {
    throw new Error("supervisor_root_response_missing");
  }
  return output;
}
