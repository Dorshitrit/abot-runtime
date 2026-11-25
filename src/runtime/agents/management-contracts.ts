import type { AgentAuthoringInput, AgentAuthoringPreview } from "./authoring.js";
import type { AgentDefinition, AgentRecord } from "./agent-records.js";
import type { RequestExecutionPolicyId } from "../../shared/request-execution-policy.js";

/** Trusted management configuration; execution policy is derived by the runtime. */
export type AgentDefinitionInput = Omit<AgentDefinition, "executionPolicy">;

export type AgentManagementInput = AgentDefinitionInput | { authoring: AgentAuthoringInput };

export type AgentModelBinding =
  | Readonly<{
      status: "configured";
      baseProfileId: string;
      executionPolicy: RequestExecutionPolicyId;
    }>
  | Readonly<{
      status: "unavailable";
      reason: "profile_missing" | "profile_overridden" | "execution_policy_changed";
    }>;

/** Configuration visibility only: configured does not imply an available provider or running work. */
export type AgentCatalog = Readonly<{
  revision: number;
  agents: readonly (AgentRecord & Readonly<{ modelBinding: AgentModelBinding }>)[];
}>;

/** Internal service. No mission, session adoption, dispatch or model-facing command API. */
export type AgentManagementService = Readonly<{
  read: () => Promise<AgentCatalog>;
  previewAuthoring: (authoring: unknown, targetAgentId?: string) => Promise<AgentAuthoringPreview>;
  register: (definition: AgentManagementInput, expectedRevision: number) => Promise<AgentCatalog>;
  update: (agentId: string, definition: AgentManagementInput, expectedRevision: number) => Promise<AgentCatalog>;
  archive: (agentId: string, expectedRevision: number) => Promise<AgentCatalog>;
  restore: (agentId: string, expectedRevision: number) => Promise<AgentCatalog>;
  reconcile: () => Promise<AgentCatalog>;
}>;
