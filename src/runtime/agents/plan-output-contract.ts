import type { ModelGatewayJsonSchemaFormat } from "../../model-gateway/types.js";
import { validateJsonSchemaValue } from "../model/json-schema-value.js";
import { createStructuredDecisionEnvelopeSchema, readStructuredDecisionEnvelope, structuredDecisionVariantSchemaPath } from "../model/structured-decision-envelope.js";
import { AgentStateError } from "./state-error.js";
import type { AgentActionPlan, AgentWorkAttempt } from "./workspace-records.js";
import { readAgentActionPlan } from "./workspace-validation.js";

export const AGENT_PUBLIC_UPDATE_INSTRUCTIONS = `For a work action, write publicUpdate as one short sentence for the user in their language about the next step you are taking on. The proposed action has not run yet. Keep private reasoning, instructions and session identifiers out of this message.`;

type Target = "sessionId" | "recipientAgentId" | null;
const choices: readonly { actions: readonly AgentActionPlan["action"][]; target: Target; report?: true }[] = [
  { actions: ["answer_user", "ask_user", "wait", "complete", "exhausted"], target: null },
  { actions: ["read_evidence"], target: "sessionId" },
  { actions: ["start_session"], target: null, report: true },
  { actions: ["continue_session"], target: "sessionId", report: true },
  { actions: ["delegate_agent"], target: "recipientAgentId", report: true },
];
const identifier = { type: "string", minLength: 1, maxLength: 256 };
const ids = { type: "array", maxItems: 32, items: identifier };
const variants = choices.map(({ actions, target, report }) => {
  const properties = {
    action: { type: "string", enum: actions }, reason: { type: "string", minLength: 1, maxLength: 1000 },
    sessionId: target === "sessionId" ? identifier : { type: "null" },
    recipientAgentId: target === "recipientAgentId" ? identifier : { type: "null" },
    evidenceIds: ids, metCriteriaIds: ids,
    ...(report ? { publicUpdate: { type: "string", minLength: 1, maxLength: 360 } } : {}),
  };
  return { type: "object", additionalProperties: false, properties, required: Object.keys(properties) };
});

export const AGENT_PLAN_FORMAT: ModelGatewayJsonSchemaFormat = {
  type: "json_schema", name: "persistent_agent_plan_v3", strict: true,
  schema: createStructuredDecisionEnvelopeSchema(variants),
  postValidatedSchemaConstraints: choices.flatMap(({ target, report }, index) => {
    const prefix = `${structuredDecisionVariantSchemaPath(index, choices.length)}/properties`;
    const fields = ["reason", "evidenceIds/items", "metCriteriaIds/items", ...(target ? [target] : []), ...(report ? ["publicUpdate"] : [])];
    return fields.map((field) => ({ keyword: "maxLength" as const, path: `${prefix}/${field}/maxLength` }));
  }),
};

const returnedChoices = (["answer_user", "continue_session"] as const).map(action => {
  const properties = {
    action: { type: "string", enum: [action] }, reason: { type: "string", minLength: 1, maxLength: 1000 },
    ...(action === "continue_session" ? { publicUpdate: { type: "string", minLength: 1, maxLength: 360 } } : {}),
  };
  return { type: "object", additionalProperties: false, properties, required: Object.keys(properties) };
});

export const AGENT_WORK_RESULT_FORMAT: ModelGatewayJsonSchemaFormat = {
  type: "json_schema", name: "persistent_agent_work_result_v1", strict: true,
  schema: createStructuredDecisionEnvelopeSchema(returnedChoices),
  postValidatedSchemaConstraints: returnedChoices.flatMap((variant, index) => {
    const prefix = structuredDecisionVariantSchemaPath(index, returnedChoices.length);
    return Object.keys(variant.properties).filter(key => key !== "action").map(key => ({
      keyword: "maxLength" as const, path: `${prefix}/properties/${key}/maxLength`,
    }));
  }),
};

/** Check the same contract the provider receives, then hand the unchanged domain plan to its guards. */
export function readAgentPlanOutput(text: string, receipt?: AgentWorkAttempt): AgentActionPlan {
  const decoded: unknown = JSON.parse(text);
  const format = receipt ? AGENT_WORK_RESULT_FORMAT : AGENT_PLAN_FORMAT;
  if (validateJsonSchemaValue(format.schema, decoded)) throw new AgentStateError("agents_plan_invalid");
  const proposal = readStructuredDecisionEnvelope(decoded);
  if (!receipt) return readAgentActionPlan(proposal);
  return readAgentActionPlan({ ...proposal, sessionId: proposal?.action === "continue_session" ? receipt.request.sessionId : null,
    recipientAgentId:null, evidenceIds:[receipt.id], metCriteriaIds:[] });
}
