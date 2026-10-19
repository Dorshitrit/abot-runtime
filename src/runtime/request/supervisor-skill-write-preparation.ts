import { hasSuperContextContract } from "../context/super-context-policy.js";
import type { RoleCallLedger, RoleChildReturnContext } from "../orchestration/role-calls/index.js";
import type { RootContractDecision } from "./root-contract.js";
import type { RootDecisionActivation } from "./root-execution-contracts.js";
import type { RequestExecutionScope } from "./execution-scope.js";
import { resolveRequestSteeringInbox } from "./request-steering.js";
import { performRootReferenceAction } from "./root-reference-action.js";
import { canRootReadSkills } from "./root-skill-read.js";
import { findCapturedPersonalSkillEditTarget } from "./supervisor-skill-edit-target.js";

const SKILL_DOCUMENT_ASSIGNMENT =
  "Produce only the complete reusable Markdown Skill document requested by the user. Transform the supplied sources into guidance; do not copy the request, runtime instructions, or context envelopes. For an edit, preserve content outside the requested changes.";

type WritePreparationDecision = Extract<RootContractDecision, { action: "prepare_skill_write" }>;
type PreparedActivation = RootDecisionActivation & Readonly<{
  decision: Extract<RootContractDecision, { action: "invoke_capability" | "respond" }>;
}>;

/** Prepare the already selected write without returning to routing or discovery. */
export async function prepareSupervisorSkillWrite(params: {
  request: RequestExecutionScope;
  ledger: RoleCallLedger;
  activation: RootDecisionActivation & Readonly<{ decision: WritePreparationDecision }>;
  resume: RoleChildReturnContext | undefined;
}): Promise<Readonly<{ activation: PreparedActivation; resume: RoleChildReturnContext | undefined }> | undefined> {
  const { request, ledger } = params;
  let { activation, resume } = params;
  const steering = resolveRequestSteeringInbox(request.requestSteering);
  request.abortSignal.throwIfAborted();
  if (!steering.isCurrent(activation.decisionSteeringVersion)) return undefined;
  if (!isSupervisorWritePreparation(activation)) throw new Error("supervisor_skill_authority_invalid");
  const selection = activation.decision.selection;
  if (selection.action === "create_skill") {
    return { activation: prepareInvocation(activation, { name: selection.name, description: selection.description }), resume };
  }
  let target = findCapturedPersonalSkillEditTarget(activation.head, selection.skillId);
  if (!target) {
    if (!canRootReadSkills(request, activation.head, activation.call)) {
      return { activation: prepareNoSave(activation, "The requested Skill edit could not load its exact target within the request budget."), resume };
    }
    resume = await performRootReferenceAction(request, ledger, {
      ...activation,
      decision: { action: "read_skills", skillIds: [selection.skillId] },
    }, resume);
    request.abortSignal.throwIfAborted();
    if (!steering.isCurrent(activation.decisionSteeringVersion)) return undefined;
    const head = ledger.current();
    const callIdentity = request.executionPolicy.rootContract.projectCallIdentity(head);
    const call = head.state.calls.find(({ callId }) => callId === callIdentity.callId);
    if (!call) throw new Error("supervisor_call_frame_missing");
    activation = { ...activation, head, call, callIdentity };
    target = findCapturedPersonalSkillEditTarget(head, selection.skillId);
  }
  if (!target) {
    return { activation: prepareNoSave(activation, "No Skill was saved: the selected exact personal Skill is unavailable or read-only."), resume };
  }
  return {
    activation: prepareInvocation(activation, {
      skillId: target.skillId, expectedRevision: target.revision,
      ...(selection.name !== undefined ? { name: selection.name } : {}),
      ...(selection.description !== undefined ? { description: selection.description } : {}),
    }), resume,
  };
}

function isSupervisorWritePreparation(activation: RootDecisionActivation): boolean {
  if (!hasSuperContextContract(activation.head.policy.authority, "supervisor")) return false;
  if (activation.call.callId !== activation.head.state.rootCallId) return false;
  return activation.call.parentCallId === null;
}

function prepareInvocation(
  activation: RootDecisionActivation & Readonly<{ decision: WritePreparationDecision }>,
  controls: Extract<RootContractDecision, { action: "invoke_capability" }>["controls"],
): PreparedActivation {
  const selection = activation.decision.selection;
  const title = selection.action === "create_skill" ? selection.name : selection.skillId;
  return { ...activation, decision: {
    action: "invoke_capability", capabilityId: selection.action,
    intent: `${selection.action === "create_skill" ? "Create" : "Update"} Skill: ${title}`,
    authoringObjective: SKILL_DOCUMENT_ASSIGNMENT, controls,
  } };
}

function prepareNoSave(activation: RootDecisionActivation, reason: string): PreparedActivation {
  return { ...activation, decision: { action: "respond",
    responseRecommendation: reason, responseRecommendationOrigin: "skill_authoring_no_save" } };
}
