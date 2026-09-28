/** Active execution time only; an approval wait does not spend these budgets. */
export type RequestExecutionBudgets = Readonly<{
  requestTimeoutMs: number;
  inactivityTimeoutMs: number;
  requestRemainingMs: number;
  inactivityRemainingMs: number;
}>;

export function assertExecutionBudgets(value: RequestExecutionBudgets): void {
  for (const number of Object.values(value)) {
    if (!Number.isFinite(number) || number < 0) {
      throw new Error("invalid_request_execution_budgets");
    }
  }
  if (value.requestRemainingMs > value.requestTimeoutMs) {
    throw new Error("invalid_request_execution_budgets");
  }
  if (value.inactivityRemainingMs > value.inactivityTimeoutMs) {
    throw new Error("invalid_request_execution_budgets");
  }
}
