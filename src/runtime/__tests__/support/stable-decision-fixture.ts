import type { CapabilityDescriptor } from "../../orchestration/capability-adapters/index.js";
import type { StableExecutionAgentDecisionFormatOptions } from "../../steps/execution-agent/stable-decision-format.js";

export const stableReadCapability: CapabilityDescriptor = {
  capabilityId: "read_file", summary: "Read one file.", effect: "observation", catalogGroups: ["read"],
  controls: { type: "object", additionalProperties: false,
    properties: { path: { type: "string", minLength: 1 } }, required: ["path"] },
};
export const stableWriteCapability: CapabilityDescriptor = {
  capabilityId: "write_file", summary: "Write one file.", effect: "mutation", catalogGroups: ["write"],
  selectionControlIds: ["path"],
  controls: { type: "object", additionalProperties: false,
    properties: { path: { type: "string", minLength: 1 }, content: { type: "string", minLength: 1 } }, required: ["path", "content"] },
};
export const stableFormatOptions: StableExecutionAgentDecisionFormatOptions = {
  capabilities: [stableReadCapability, stableWriteCapability], capabilityCatalogGroupIds: ["read", "write"],
  activeCapabilityCatalogGroupIds: ["read", "write"],
  includeAcknowledgement: false, includeTitle: false, includeWorkingDirectory: true, allowWorkPlan: true,
  allowUserInteraction: true, allowMemoryRecall: true, allowPlanner: true, allowAuditor: true,
  allowDirectResponse: true, allowMemoryAuthoring: true,
};

export type DecisionSchemaNode = {
  type?: string; properties?: Record<string, DecisionSchemaNode>; required?: string[];
  enum?: string[]; anyOf?: DecisionSchemaNode[]; items?: DecisionSchemaNode;
  maxItems?: number; maxLength?: number; $ref?: string; $defs?: Record<string, DecisionSchemaNode>;
};

export function stableDecisionVariants(schema: DecisionSchemaNode): DecisionSchemaNode[] {
  const decision = schema.properties!.decision!;
  return decision.anyOf ?? [decision];
}
