import { describe, expect, test } from "vitest";

import {
  EXECUTION_AGENT_V1_EXECUTION_POLICY,
  resolveRequestExecutionPolicy,
  SUPERVISOR_WORKER_V1_EXECUTION_POLICY,
} from "../request/role-executor-composition.js";
import type { RequestExecutionPolicyId } from "../config/model-execution-policy.js";

describe("request execution policy composition", () => {
  test("binds omitted and explicit supervisor-worker-v1 selection to one policy", () => {
    expect(resolveRequestExecutionPolicy()).toBe(
      SUPERVISOR_WORKER_V1_EXECUTION_POLICY,
    );
    expect(resolveRequestExecutionPolicy("supervisor-worker-v1")).toBe(
      SUPERVISOR_WORKER_V1_EXECUTION_POLICY,
    );
    expect(SUPERVISOR_WORKER_V1_EXECUTION_POLICY).toMatchObject({
      authority: {
        id: "supervisor-worker-v1",
        version: 1,
        definitionHash:
          "sha256:40cf0e04cbf5cf2f0ae5ce6d0e1c7aa87c21247416a7771441083ec0c73db62f",
        rootContractId: "supervisor",
        availableSubordinateContractIds: ["planner", "worker", "reviewer"],
        capabilityAuthorities: ["worker"],
      },
      rootContract: { contractId: "supervisor" },
      roleExecutors: { roleIds: ["planner", "worker", "reviewer"] },
    });
    expect(Object.isFrozen(SUPERVISOR_WORKER_V1_EXECUTION_POLICY)).toBe(true);
  });

  test("binds execution-agent-v1 to advisory roles with root-only capability authority", () => {
    expect(resolveRequestExecutionPolicy("execution-agent-v1")).toBe(
      EXECUTION_AGENT_V1_EXECUTION_POLICY,
    );
    expect(EXECUTION_AGENT_V1_EXECUTION_POLICY).toMatchObject({
      authority: {
        id: "execution-agent-v1",
        version: 1,
        definitionHash:
          "sha256:13c15efe75cdc96f225a1034fd5c36461b1a623fe91c78f9023740a4d42f5748",
        rootContractId: "execution_agent",
        availableSubordinateContractIds: ["planner", "reviewer"],
        capabilityAuthorities: ["root"],
        terminalTextMode: "exact",
      },
      rootContract: {
        contractId: "execution_agent",
        decisionModelStep: "execution.decision",
        responseModelStep: "execution.response",
      },
      roleExecutors: { roleIds: ["planner", "reviewer"] },
    });
    expect(Object.isFrozen(EXECUTION_AGENT_V1_EXECUTION_POLICY)).toBe(true);
  });

  test("rejects an unregistered policy without fallback", () => {
    expect(() =>
      resolveRequestExecutionPolicy(
        "unregistered-policy" as RequestExecutionPolicyId,
      ),
    ).toThrow("execution_policy_not_registered:unregistered-policy");
  });
});
