import type { ToolNormalInvocationContract, ToolNormalInvocationOperation } from "../../capabilities/tool-types.js";
import { schedulingToolContract } from "./scheduling/tool-contract.js";
import { automationModelToolContract } from "./automations/model-tool-contract.js";
import { automationBuilderToolContract } from "./automation-builder/tool-contract.js";
import { knowledgeSkillsToolContract } from "./knowledge-skills/tool-contract.js";

type CoreToolContract = Readonly<{
  name: string;
  normalInvocation: ToolNormalInvocationContract;
  readApproval: "request_policy" | "automatic";
}>;

function coreToolContract(
  name: string,
  normalInvocation: ToolNormalInvocationContract,
  readApproval: CoreToolContract["readApproval"] = "request_policy",
): CoreToolContract {
  return Object.freeze({ name, normalInvocation, readApproval });
}

/** One source for native definitions and their reserved plugin identities. */
export const CORE_TOOL_CONTRACTS = Object.freeze({
  skills: coreToolContract("abot_skills", knowledgeSkillsToolContract, "automatic"),
  scheduling: coreToolContract("schedules", schedulingToolContract),
  automations: coreToolContract("automations", automationModelToolContract),
  automationBuilder: coreToolContract("automation_builder", automationBuilderToolContract),
});

const coreTools = Object.values(CORE_TOOL_CONTRACTS);
const coreToolNames: ReadonlySet<string> = new Set(coreTools.map(({ name }) => name));
const coreOperationIds: ReadonlySet<string> = new Set(coreTools.flatMap(
  ({ normalInvocation }) => normalInvocation.operations.map(({ operationId }) => operationId),
));

/** Core policy only; public plugins cannot opt out of request approval. */
export function isCoreToolAutomaticRead(
  toolName: string,
  operation: Pick<ToolNormalInvocationOperation, "operationId" | "effect">,
): boolean {
  const core = coreTools.find(({ name }) => name === toolName);
  if (core?.readApproval !== "automatic") return false;
  if (operation.effect !== "read_only") return false;
  return core.normalInvocation.operations.some((candidate) =>
    candidate.operationId === operation.operationId && candidate.effect === "read_only",
  );
}

export function hasCoreToolContractCollision(
  capabilities: Readonly<Record<string, {
    operations: Readonly<Record<string, unknown>>;
  }>>,
): boolean {
  for (const [name, capability] of Object.entries(capabilities)) {
    const hasReservedToolName = coreToolNames.has(name);
    if (hasReservedToolName) return true;
    const hasReservedOperationId = Object.keys(capability.operations)
      .some((operationId) => coreOperationIds.has(operationId));
    if (hasReservedOperationId) return true;
  }
  return false;
}
