import type { ModelGatewayClient } from "../../ports.js";

type ModelInput = Parameters<ModelGatewayClient["invoke"]>[0];
export type SupervisorPhaseDecision = (input: ModelInput) => unknown | Promise<unknown>;

export function supervisorFormatName(input: ModelInput): string | undefined {
  if (input.modelStep !== "supervisor.decision") return undefined;
  if (typeof input.format !== "object" || input.format === null) return undefined;
  return typeof input.format.name === "string" ? input.format.name : undefined;
}

export function defaultSupervisorPresentation(input: ModelInput, acknowledgement = "I understand the requested outcome and am starting now.") {
  if (typeof input.format !== "object" || input.format === null) throw new Error("presentation_format_missing");
  const schema = input.format.schema as {
    properties?: { decision?: { required?: readonly string[] } };
  };
  const required = schema.properties?.decision?.required ?? [];
  return {
    ...(required.includes("acknowledgement") ? { acknowledgement } : {}),
    ...(required.includes("title") ? { title: "Handle the request" } : {}),
  };
}

/** Adapts older routing scripts while exposing every actual call to the gateway spy. */
export function withSupervisorPreparation(
  invoke: ModelGatewayClient["invoke"],
  options: Readonly<{
    present?: SupervisorPhaseDecision;
    selectSkills?: SupervisorPhaseDecision;
  }> = {},
): ModelGatewayClient["invoke"] {
  return async (input) => {
    const phase = supervisorFormatName(input);
    if (phase === "supervisor_presentation") {
      const decision = await (options.present ?? defaultSupervisorPresentation)(input);
      return { text: typeof decision === "string" ? decision : JSON.stringify({ decision }), meta: {} };
    }
    if (phase === "supervisor_skill_selection") {
      const decision = await (options.selectSkills ?? (() => ({ action: "continue" })))(input);
      return { text: typeof decision === "string" ? decision : JSON.stringify({ decision }), meta: {} };
    }
    const response = await invoke(input);
    if (phase !== "supervisor_decision") return response;
    let decoded: { decision?: Record<string, unknown> };
    try { decoded = JSON.parse(response.text); }
    catch { return response; }
    if (typeof decoded?.decision !== "object" || decoded.decision === null) return response;
    const { acknowledgement: _acknowledgement, title: _title, ...decision } = decoded.decision;
    return { ...response, text: JSON.stringify({ ...decoded, decision }) };
  };
}
