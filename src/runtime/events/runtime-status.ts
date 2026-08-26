import type { RequestLifecycleState } from "../orchestration/lifecycle/request-lifecycle.js";
import type { RequestExecutionSeed } from "../request/contracts.js";

type RuntimeStatusTarget = Pick<RequestExecutionSeed, "onEvent">;

export function emitRuntimeStatus(
  request: RuntimeStatusTarget,
  state: RequestLifecycleState,
): void {
  request.onEvent("runtime.state", state);
}
