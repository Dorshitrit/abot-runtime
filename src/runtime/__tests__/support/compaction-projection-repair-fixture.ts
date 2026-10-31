import { vi } from "vitest";
import { createAdmissionStage } from "./compaction-admission-fixture.js";

export function createProjectionRepairStage(
  scope: "session_history" | "active_request",
) {
  const stage = createAdmissionStage(scope, "unused");
  const firstCommit = vi.fn<() => void | Promise<void>>();
  const repairCommit = vi.fn<() => void | Promise<void>>();
  stage.prepare.mockImplementation(async (messages, context) => ({
    kind: "prepared",
    preparation: {
      messages: [
        ...messages,
        {
          role: "system",
          content: `${scope}:${context?.projectionRepair ? "repair" : "first"}`,
        },
      ],
      scopeId: stage.scopeId,
      sourceRevision: scope === "session_history" ? "history-revision" : 2,
      coveredSourceCount: 1,
      hasExhaustedCompactionSources: true,
      commit: context?.projectionRepair ? repairCommit : firstCommit,
    },
  }));
  return {
    ...stage,
    ...(scope === "active_request"
      ? { supportsProjectionRepair: true as const }
      : {}),
    firstCommit,
    repairCommit,
  };
}
