import type { ModelGatewayClient } from "../../ports.js";

type ModelInput = Parameters<ModelGatewayClient["invoke"]>[0];
export type SupervisorPhaseDecision = (input: ModelInput) => unknown | Promise<unknown>;
type ModelResponse = Awaited<ReturnType<ModelGatewayClient["invoke"]>>;

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
    classifyProcedure?: SupervisorPhaseDecision;
    delegate?: SupervisorPhaseDecision;
  }> = {},
): ModelGatewayClient["invoke"] {
  // Legacy scripts express one semantic proposal. Translate its protocol into
  // the two calls without inventing the model's input or invoking the script
  // twice. Context-sensitive tests should supply explicit phase callbacks;
  // procedure orchestration tests use a direct gateway without this adapter.
  let legacyDelegation: ModelResponse | undefined;
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
    if (phase === "supervisor_procedure_gate") {
      legacyDelegation = undefined;
      if (options.classifyProcedure) return phaseResponse(await options.classifyProcedure(input));
      const response = await invoke(input);
      const decision = readDecision(response);
      if (decision?.action === "respond") {
        return phaseResponse({
          requiresProcedure: false,
          ...(Object.hasOwn(decision, "responseRecommendation")
            ? { responseRecommendation: decision.responseRecommendation } : {}),
        }, response);
      }
      if (isLegacyProcedureProposal(decision)) {
        legacyDelegation = response;
        return phaseResponse({ requiresProcedure: true }, response);
      }
      return response;
    }
    if (phase === "supervisor_delegation") {
      if (options.delegate) return phaseResponse(await options.delegate(input));
      const response = legacyDelegation ?? await invoke(input);
      legacyDelegation = undefined;
      const decision = readDecision(response);
      if (!decision) return response;
      const { acknowledgement: _ack, title: _title, workerCapabilityScope: _scope, ...assignment } = decision;
      return phaseResponse(assignment, response);
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

function phaseResponse(decision: unknown, response?: ModelResponse): ModelResponse {
  return { ...response, text: typeof decision === "string" ? decision : JSON.stringify({ decision }), meta: response?.meta ?? {} };
}

function readDecision(response: ModelResponse): Record<string, unknown> | undefined {
  try {
    const decision = JSON.parse(response.text)?.decision;
    if (typeof decision !== "object" || decision === null || Array.isArray(decision)) return undefined;
    return decision;
  } catch { return undefined; }
}

function isLegacyProcedureProposal(decision: Record<string, unknown> | undefined): boolean {
  return ["invoke_role", "recall_memory", "author_skill"].includes(String(decision?.action));
}
