import { expect, test } from "vitest";
import { hasSuperContextContract } from "../context/super-context-policy.js";
import { SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT as authority } from "../orchestration/role-calls/contracts.js";
import { EXECUTION_AGENT_V1_EXECUTION_POLICY } from "../request/role-executor-composition.js";

test.each([
  "supervisor",
  "delegated.worker",
  "delegated.planner",
  "delegated.reviewer",
])("only the frozen registered SUPER authority enables %s", (contract) => {
  expect(hasSuperContextContract(authority, contract)).toBe(true);
  expect(
    hasSuperContextContract(
      EXECUTION_AGENT_V1_EXECUTION_POLICY.authority,
      contract,
    ),
  ).toBe(false);
  expect(
    hasSuperContextContract(
      { ...authority, definitionHash: "different" },
      contract,
    ),
  ).toBe(false);
  expect(
    hasSuperContextContract(
      { ...authority, version: authority.version + 1 },
      contract,
    ),
  ).toBe(false);
  expect(
    hasSuperContextContract(
      { ...authority, capabilityAuthorities: ["root"] },
      contract,
    ),
  ).toBe(false);
  expect(
    hasSuperContextContract(
      { ...authority, terminalTextMode: "exact" },
      contract,
    ),
  ).toBe(false);
});

test.each([
  "worker",
  "planner",
  "reviewer",
  "direct.planner_advisory",
  "direct.auditor_advisory",
  "execution-agent",
])("role names and non-SUPER contracts do not enable %s", (contract) =>
  expect(hasSuperContextContract(authority, contract)).toBe(false),
);
