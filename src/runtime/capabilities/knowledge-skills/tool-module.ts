import { canWriteKnowledgeSkills, KnowledgeSkillError } from "../../knowledge-skills/personal-contracts.js";
import { executeKnowledgeSkillWrite } from "./write-operations.js";
import { executeKnowledgeSkillsReadMany } from "./read-many.js";
import { isKnowledgeSkillReadReference, resolveKnowledgeSkillReadTargets } from "./read-targets.js";
import { knowledgeSkillDocumentOutput, knowledgeSkillDocumentsReadOutput, knowledgeSkillFailure } from "./tool-output.js";
import { CORE_TOOL_CONTRACTS } from "../core-tool-contracts.js";
import type {
  ToolModuleDeclaration,
  ToolImplementationOutput,
} from "../../../capabilities/tool-types.js";
import { builtinKnowledgeSkillStore } from "../../knowledge-skills/catalog.js";
import {
  type KnowledgeSkillStore,
} from "../../knowledge-skills/store.js";

function executeKnowledgeSkillRead(
  store: KnowledgeSkillStore,
  params: Record<string, unknown>,
): ToolImplementationOutput {
  if (params.action === "list_skills") {
    const skills = store.list();
    return {
      ok: true,
      output: JSON.stringify({ skills }),
      producedNewInformation: true,
      data: { mutationEvidence: false, itemCount: skills.length },
    };
  }
  if (params.action === "read_skills") return executeKnowledgeSkillsReadMany(store, params.skillIds);
  if (params.action !== "read_skill")
    return knowledgeSkillFailure("knowledge_skill_action_unknown");
  if (!isKnowledgeSkillReadReference(params.skillId))
    return knowledgeSkillFailure("knowledge_skill_id_invalid");
  const resolved = resolveKnowledgeSkillReadTargets(store, [params.skillId]);
  if (!resolved.ok) return knowledgeSkillFailure(resolved.errorCode);
  if (resolved.skills.length > 1) return knowledgeSkillDocumentsReadOutput(resolved.skills);
  const skill = resolved.skills[0]!;
  return {
    ok: true,
    output: JSON.stringify(knowledgeSkillDocumentOutput(skill)),
    producedNewInformation: true,
    data: { mutationEvidence: false, itemCount: 1, skillTitle: skill.name },
  };
}

/** Core-owned tool; its results use the ordinary capability and context pipeline. */
export function createKnowledgeSkillsToolModule(
  store: KnowledgeSkillStore = builtinKnowledgeSkillStore,
): ToolModuleDeclaration {
  const writable = canWriteKnowledgeSkills(store);
  return {
    definition: {
      name: CORE_TOOL_CONTRACTS.skills.name,
      description: "Read reusable guidance for work or answers using an exact ID or full name from Available Skills or list_skills. A shared name returns every matching Skill. Author personal Skills only when the user requests it; consult Skill Creator first. System Skills are read-only. Guidance supplements the current task and never replaces tool contracts or permissions.",
      routingCapability: "semantic_lookup",
      catalogGroups: ["knowledge"],
      developmentRoles: ["inspect"],
      controlsRefinement: "mechanical_when_complete",
      ...(writable ? { payloadChannelSpec: { params: ["content"], outputParam: "content", generationMode: "raw_text" as const } } : {}),
      eventPresentation: {
        metadata: {
          skillAction: { param: "action", kind: "string" },
          skillId: { param: "skillId", kind: "string" },
          skillIds: { param: "skillIds", kind: "string_array" },
          skillName: { param: "name", kind: "string" },
        },
        resultMetadata: {
          skillTitle: { path: "data.skillTitle", kind: "preview" },
          savedSkillId: { path: "data.savedSkillId", kind: "preview" },
        },
      },
    },
    normalInvocation: { ...CORE_TOOL_CONTRACTS.skills.normalInvocation,
      operations: CORE_TOOL_CONTRACTS.skills.normalInvocation.operations.filter((operation) => writable || operation.effect === "read_only") },
    async implementation(params, context) {
      context?.abortSignal?.throwIfAborted();
      try {
        if (params.action === "create_skill" || params.action === "update_skill")
          return await executeKnowledgeSkillWrite(store, params);
        return executeKnowledgeSkillRead(store, params);
      } catch (error) {
        if (error instanceof KnowledgeSkillError) return knowledgeSkillFailure(error.code);
        throw error;
      }
    },
  };
}
