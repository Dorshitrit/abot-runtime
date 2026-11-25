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
    properties?: { decision?: { required?: readonly string[]; anyOf?: readonly { required?: readonly string[] }[] } };
  };
  const decision = schema.properties?.decision;
  const required = decision?.required ?? decision?.anyOf?.[0]?.required ?? [];
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
    workingDirectories?: Readonly<{ planner: string; worker: string }>;
  }> = {},
): ModelGatewayClient["invoke"] {
  // Translate legacy semantic proposals while exposing the actual fused input.
  // Context-sensitive orchestration tests use a direct gateway.
  let legacyDelegation: ModelResponse | undefined;
  return async (input) => {
    const phase = supervisorFormatName(input);
    if (phase === "supervisor_fused_entry" || phase === "supervisor_fused_entry_with_memory_candidates") {
      legacyDelegation = undefined;
      const presentation = await (options.present ?? defaultSupervisorPresentation)(input);
      if (options.selectSkills && JSON.stringify(input.format).includes('"read_skills"')) {
        const selection = await options.selectSkills(input);
        if (typeof selection === "string") return phaseResponse(selection);
        if (typeof selection === "object" && selection !== null && "action" in selection && selection.action === "read_skills")
          return phaseResponse({ ...selection, ...presentation as object });
      }
      if (options.classifyProcedure)
        return phaseResponse({ ...await options.classifyProcedure(input) as object, ...presentation as object });
      const response = await invoke(input);
      const decision = readDecision(response);
      if (typeof decision?.requiresProcedure === "boolean")
        return phaseResponse({ ...presentation as object, ...decision }, response);
      if (decision?.action === "respond") return phaseResponse({
        requiresProcedure: false,
        ...(Object.hasOwn(decision, "responseRecommendation") ? { responseRecommendation: decision.responseRecommendation } : {}),
        ...(phase === "supervisor_fused_entry_with_memory_candidates" && Object.hasOwn(decision, "memoryCandidates")
          ? { memoryCandidates: decision.memoryCandidates } : {}),
        ...presentation as object,
      }, response);
      if (isLegacyProcedureProposal(decision)) {
        legacyDelegation = response;
        return phaseResponse({ requiresProcedure: true, ...presentation as object }, response);
      }
      return response;
    }
    if (phase === "supervisor_fused_routing") {
      const response = options.delegate ? phaseResponse(await options.delegate(input)) : legacyDelegation ?? await invoke(input);
      legacyDelegation = undefined;
      const decision = readDecision(response);
      if (!decision) return response;
      const { acknowledgement, title, ...routing } = decision;
      const presentation = defaultSupervisorPresentation(input);
      const assignment: Record<string, unknown> = { ...routing, ...presentation,
        ...(presentation.acknowledgement && acknowledgement ? { acknowledgement } : {}),
        ...(presentation.title && title ? { title } : {}),
      };
      if (assignment.action !== "invoke_role" || (assignment.roleId !== "worker" && assignment.roleId !== "planner"))
        return phaseResponse(assignment, response);
      return phaseResponse({ ...assignment,
        workingDirectory: assignment.workingDirectory ?? options.workingDirectories?.[assignment.roleId] ?? ".",
      }, response);
    }
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
      const { acknowledgement: _ack, title: _title, ...assignment } = decision;
      return phaseResponse(assignment, response);
    }
    if ((phase === "supervisor_resume_skill_routing" || phase === "supervisor_decision_with_memory_candidates") && options.selectSkills
      && JSON.stringify(input.format).includes('"read_skills"')) {
      const selection = await options.selectSkills(input);
      if (typeof selection === "string") return phaseResponse(selection);
      if (typeof selection === "object" && selection !== null && "action" in selection
        && selection.action === "read_skills") return phaseResponse(selection);
    }
    const response = await invoke(input);
    if (phase !== "supervisor_decision" && phase !== "supervisor_decision_with_memory_candidates"
      && phase !== "supervisor_resume_skill_routing") return response;
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
