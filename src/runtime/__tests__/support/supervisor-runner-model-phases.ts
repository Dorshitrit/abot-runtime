import type { ModelGatewayClient } from "../../ports.js";
import { supervisorFormatName, withSupervisorPreparation } from "./supervisor-model-phases.js";

/** Preserves the older runner scripts while exercising the real split authoring calls. */
export function separateSupervisorRunnerModelPhases(
  invoke: ModelGatewayClient["invoke"],
  workingDirectories: Readonly<{ planner: string; worker: string }>,
): ModelGatewayClient["invoke"] {
  const pendingWorkerResults: string[] = [];
  return withSupervisorPreparation(async (input) => {
    if (supervisorFormatName(input) === "supervisor_working_directory") {
      const frozenInvocation = (
        input.messages as readonly Readonly<{ content: string }>[]
      ).flatMap((message) => {
        try {
          const parsed = JSON.parse(message.content) as Record<string, unknown>;
          return parsed.kind === "runtime_supervisor_frozen_invocation_v1" ? [parsed] : [];
        } catch { return []; }
      }).at(-1);
      if (frozenInvocation?.roleId !== "planner" && frozenInvocation?.roleId !== "worker")
        throw new Error("supervisor_working_directory_fixture_invalid");
      return {
        text: JSON.stringify({ workingDirectory: workingDirectories[frozenInvocation.roleId] }),
        meta: {},
      };
    }
    if (input.modelStep === "worker.result") {
      const result = pendingWorkerResults.shift();
      if (result === undefined) throw new Error("worker_result_test_fixture_missing");
      return { text: result, meta: {} };
    }
    const response = await invoke(input);
    if (input.modelStep !== "worker.decision") return response;
    let decoded: unknown;
    try { decoded = JSON.parse(response.text); }
    catch { return response; }
    const decision = typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)
      ? (decoded as Record<string, unknown>).decision : undefined;
    if (typeof decision !== "object" || decision === null || Array.isArray(decision)) return response;
    if ((decision as Record<string, unknown>).action !== "return_result") return response;
    const result = (decision as Record<string, unknown>).result;
    if (typeof result !== "string") return response;
    pendingWorkerResults.push(result);
    return { ...response, text: JSON.stringify({ decision: { action: "return_result" } }) };
  });
}
