import { createHash } from "node:crypto";

import {
  createRoleExecutorRegistry,
  type RoleExecutor,
  type RoleExecutorRegistry,
} from "../orchestration/role-executors/index.js";
import { SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT } from "../orchestration/role-calls/index.js";
import type { RuntimeDelegateRoleId } from "../orchestration/roles.js";
import type {
  CompiledRequestExecutionPolicy,
  RequestExecutionScope,
} from "./execution-scope.js";
import type { RequestRoleExecutionHandoff } from "./result.js";
import { GENERIC_PLANNER_EXECUTOR } from "../steps/planner-decision/index.js";
import { GENERIC_WORKER_EXECUTOR } from "../steps/worker-decision/index.js";
import { GENERIC_REVIEWER_EXECUTOR } from "../steps/reviewer-decision/index.js";
import { EXECUTION_AGENT_PLANNER_EXECUTOR } from "../steps/planner-graph/index.js";
import { EXECUTION_AGENT_AUDITOR_EXECUTOR } from "../steps/auditor-decision/index.js";
import {
  DEFAULT_REQUEST_EXECUTION_POLICY_ID,
  type RequestExecutionPolicyId,
} from "../config/model-execution-policy.js";
import { SUPERVISOR_ROOT_CONTRACT } from "./supervisor-root-execution.js";
import { EXECUTION_AGENT_ROOT_CONTRACT } from "./execution-agent-root-execution.js";

type RequestRoleExecutor = RoleExecutor<
  RequestExecutionScope,
  RequestRoleExecutionHandoff
>;

const REQUEST_ROLE_EXECUTOR_CATALOG = sealRequestRoleExecutorCatalog([
  {
    contractId: "delegated.planner",
    executor: GENERIC_PLANNER_EXECUTOR,
  },
  {
    contractId: "delegated.worker",
    executor: GENERIC_WORKER_EXECUTOR,
  },
  {
    contractId: "delegated.reviewer",
    executor: GENERIC_REVIEWER_EXECUTOR,
  },
  {
    contractId: "direct.planner_advisory",
    executor: EXECUTION_AGENT_PLANNER_EXECUTOR,
  },
  {
    contractId: "direct.auditor_advisory",
    executor: EXECUTION_AGENT_AUDITOR_EXECUTOR,
  },
] as const);

export const REQUEST_ROLE_EXECUTORS: RoleExecutorRegistry<
  RequestExecutionScope,
  RequestRoleExecutionHandoff
> = projectRequestRoleExecutorRegistry([
  "delegated.planner",
  "delegated.worker",
  "delegated.reviewer",
]);

export const EXECUTION_AGENT_ROLE_EXECUTORS: RoleExecutorRegistry<
  RequestExecutionScope,
  RequestRoleExecutionHandoff
> = projectRequestRoleExecutorRegistry([
  "direct.planner_advisory",
  "direct.auditor_advisory",
]);

const SUPERVISOR_WORKER_V1_POLICY_DEFINITION = Object.freeze({
  id: "supervisor-worker-v1" as const,
  version: 2,
  rootContract: SUPERVISOR_ROOT_CONTRACT,
  roleExecutors: REQUEST_ROLE_EXECUTORS,
  capabilityAuthorities: Object.freeze(["worker"] as const),
});

const EXECUTION_AGENT_V1_POLICY_DEFINITION = Object.freeze({
  id: "execution-agent-v1" as const,
  version: 1,
  rootContract: EXECUTION_AGENT_ROOT_CONTRACT,
  roleExecutors: EXECUTION_AGENT_ROLE_EXECUTORS,
  capabilityAuthorities: Object.freeze(["root"] as const),
  terminalTextMode: "exact" as const,
});

export const SUPERVISOR_WORKER_V1_EXECUTION_POLICY: CompiledRequestExecutionPolicy =
  compileSupervisorWorkerV1Policy();
export const EXECUTION_AGENT_V1_EXECUTION_POLICY: CompiledRequestExecutionPolicy =
  compileExecutionPolicy(EXECUTION_AGENT_V1_POLICY_DEFINITION);

export function resolveRequestExecutionPolicy(
  policyId: RequestExecutionPolicyId = DEFAULT_REQUEST_EXECUTION_POLICY_ID,
): CompiledRequestExecutionPolicy {
  switch (policyId) {
    case "supervisor-worker-v1":
      return SUPERVISOR_WORKER_V1_EXECUTION_POLICY;
    case "execution-agent-v1":
      return EXECUTION_AGENT_V1_EXECUTION_POLICY;
    default:
      throw new Error(`execution_policy_not_registered:${String(policyId)}`);
  }
}

function compileSupervisorWorkerV1Policy(): CompiledRequestExecutionPolicy {
  const definition = SUPERVISOR_WORKER_V1_POLICY_DEFINITION;
  const authority = SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT;
  const compiled = compileExecutionPolicy(definition);
  if (!sameAuthority(authority, compiled.authority)) {
    throw new Error("execution_policy_authority_definition_mismatch");
  }
  return Object.freeze({ ...compiled, authority });
}

function compileExecutionPolicy(
  definition: Readonly<{
    id: RequestExecutionPolicyId;
    version: number;
    rootContract: CompiledRequestExecutionPolicy["rootContract"];
    roleExecutors: CompiledRequestExecutionPolicy["roleExecutors"];
    capabilityAuthorities: readonly ("root" | RuntimeDelegateRoleId)[];
    terminalTextMode?: "normalized" | "exact";
  }>,
): CompiledRequestExecutionPolicy {
  const canonicalAuthorityDefinition = JSON.stringify({
    id: definition.id,
    version: definition.version,
    rootContractId: definition.rootContract.contractId,
    availableSubordinateContractIds: definition.roleExecutors.roleIds,
    capabilityAuthorities: definition.capabilityAuthorities,
    ...(definition.terminalTextMode !== undefined
      ? { terminalTextMode: definition.terminalTextMode }
      : {}),
  });
  const definitionHash = `sha256:${createHash("sha256")
    .update(canonicalAuthorityDefinition)
    .digest("hex")}`;
  const authority = Object.freeze({
    id: definition.id,
    version: definition.version,
    definitionHash,
    rootContractId: definition.rootContract.contractId,
    availableSubordinateContractIds: Object.freeze([
      ...definition.roleExecutors.roleIds,
    ]),
    capabilityAuthorities: Object.freeze([...definition.capabilityAuthorities]),
    ...(definition.terminalTextMode !== undefined
      ? { terminalTextMode: definition.terminalTextMode }
      : {}),
  });
  return Object.freeze({
    authority,
    rootContract: definition.rootContract,
    roleExecutors: definition.roleExecutors,
  });
}

function sameAuthority(
  left: typeof SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
  right: CompiledRequestExecutionPolicy["authority"],
): boolean {
  return (
    left.id === right.id &&
    left.version === right.version &&
    left.definitionHash === right.definitionHash &&
    left.rootContractId === right.rootContractId &&
    sameOrderedValues(
      left.availableSubordinateContractIds,
      right.availableSubordinateContractIds,
    ) &&
    sameOrderedValues(
      left.capabilityAuthorities,
      right.capabilityAuthorities,
    ) &&
    (left.terminalTextMode ?? "normalized") ===
      (right.terminalTextMode ?? "normalized")
  );
}

function sameOrderedValues(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sealRequestRoleExecutorCatalog<
  TEntries extends readonly Readonly<{
    contractId: string;
    executor: RequestRoleExecutor;
  }>[],
>(entries: TEntries): TEntries {
  const contractIds = entries.map(({ contractId }) => contractId);
  if (
    contractIds.some((contractId) => !contractId) ||
    new Set(contractIds).size !== contractIds.length
  ) {
    throw new Error("request_role_executor_catalog_invalid");
  }
  entries.forEach((entry) => Object.freeze(entry));
  return Object.freeze(entries);
}

function projectRequestRoleExecutorRegistry(
  contractIds: readonly (typeof REQUEST_ROLE_EXECUTOR_CATALOG)[number]["contractId"][],
): RoleExecutorRegistry<RequestExecutionScope, RequestRoleExecutionHandoff> {
  if (new Set(contractIds).size !== contractIds.length) {
    throw new Error("request_role_executor_projection_duplicate");
  }
  const executors = contractIds.map((contractId) => {
    const entry = REQUEST_ROLE_EXECUTOR_CATALOG.find(
      (candidate) => candidate.contractId === contractId,
    );
    if (!entry) {
      throw new Error(
        `request_role_executor_contract_not_registered:${contractId}`,
      );
    }
    return entry.executor;
  });
  if (
    new Set(executors.map(({ roleId }) => roleId)).size !== executors.length
  ) {
    throw new Error("request_role_executor_projection_role_duplicate");
  }
  return createRoleExecutorRegistry(executors);
}
