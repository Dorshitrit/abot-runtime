import type { ModelGatewayClient } from "../../ports.js";
import { supervisorFormatName } from "./supervisor-model-phases.js";

/** Exercise a saved scoped Worker through the role that now selects its scope. */
export function withPlannerApprovalScope(
  invoke: ModelGatewayClient["invoke"],
  catalogGroupIds: readonly string[],
): ModelGatewayClient["invoke"] {
  let plannerTurns = 0;
  return async (input) => {
    if (input.modelStep === "planner.decision") {
      plannerTurns += 1;
      const decision = plannerTurns === 1
        ? {
          action: "invoke_role", roleId: "worker",
          plan: { summary: "Perform the fixture action.", items: [
            { title: "Act", objective: "Perform the exact fixture actions." },
          ] },
          selectedItemIndexes: [0],
          workerCapabilityScope: { catalogGroupIds },
        }
        : { action: "return_result", result: "The fixture action settled." };
      return { text: JSON.stringify({ decision }), meta: {} };
    }
    const response = await invoke(input);
    if (supervisorFormatName(input) !== "supervisor_delegation") return response;
    const value = JSON.parse(response.text);
    return { ...response, text: JSON.stringify({
      decision: { ...value.decision, roleId: "planner" },
    }) };
  };
}
