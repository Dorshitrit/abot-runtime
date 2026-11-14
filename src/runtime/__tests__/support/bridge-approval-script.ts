import { createExecApprovalScript } from "./exec-sensitive-approval-script.js";

/** Exercise a saved approval group using ordinary observational batch selection. */
export function createBridgeApprovalScript(grouped: boolean) {
  const model = createExecApprovalScript(
    "execution-agent-v1",
    [{ capabilityId: "record_bridge_effect", controls: {} }],
    "bridge_fixture",
  );
  if (!grouped) return model;
  const invoke = model.invoke.getMockImplementation()!;
  model.invoke.mockImplementation(async (input) => {
    const response = await invoke(input);
    if (input.modelStep !== "execution.decision") return response;
    const selection = JSON.parse(response.text);
    if (selection.decision?.action !== "invoke_capability") return response;
    return {
      ...response,
      text: JSON.stringify({ decision: {
        action: "invoke_capabilities",
        workingDirectory: ".",
        invocations: [
          { capabilityId: "record_bridge_effect" },
          { capabilityId: "record_second_bridge_effect" },
        ],
      } }),
    };
  });
  return model;
}
