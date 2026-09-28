import type { ToolApprovalController } from "../ports.js";
import type { RequestLifecycle } from "../orchestration/lifecycle/request-lifecycle.js";

/** Decorate the approval boundary without changing approval authority. */
export function withToolApprovalWait(
  controller: ToolApprovalController,
  lifecycle: RequestLifecycle,
): ToolApprovalController {
  return {
    async requestToolApproval(request, options) {
      const releaseWait = lifecycle.beginToolApprovalWait();
      try {
        return await controller.requestToolApproval(request, options);
      } finally {
        releaseWait();
      }
    },
  };
}
