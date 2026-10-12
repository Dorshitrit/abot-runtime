import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { data } from "@actions/expressions";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  evaluateCiExpression,
  type CiScenario,
} from "./support/ci-workflow-expression.js";

type WorkflowJob = Readonly<{
  if: string;
  name?: string;
  needs?: readonly string[];
  env?: Readonly<Record<string, string>>;
  steps: readonly Readonly<{ name?: string; run?: string; if?: string }>[];
}>;
const workflow = parse(
  readFileSync(resolve(".github/workflows/ci.yml"), "utf8"),
) as {
  on: { pull_request: { types: string[] }; push: { branches: string[] } };
  concurrency: { group: string; "cancel-in-progress": string };
  jobs: Record<string, WorkflowJob>;
};
const heavyJobs = ["checks", "tests", "macos-companion", "windows-compatibility"];

function expressionBoolean(
  expression: string,
  scenario: CiScenario,
  environment: Readonly<Record<string, string>> = {},
): boolean {
  const { value } = evaluateCiExpression(expression, scenario, environment);
  assert.equal(value.kind, data.Kind.Boolean);
  return (value as data.BooleanData).value;
}

function assertValidationSelection(
  scenario: CiScenario,
  enabled: boolean,
  waitingName = "ci-awaiting-request",
): void {
  for (const name of heavyJobs) {
    expect(expressionBoolean(workflow.jobs[name].if, scenario), name).toBe(enabled);
  }
  const gate = workflow.jobs.validate;
  expect(expressionBoolean(gate.if, scenario)).toBe(true);
  expect(evaluateCiExpression(gate.if, scenario).alwaysCalls).toBe(1);
  expect(evaluateCiExpression(gate.name!, scenario).value.coerceString()).toBe(
    enabled ? "validate" : waitingName,
  );
  const full = evaluateCiExpression(gate.env!.RUN_FULL_VALIDATION, scenario).value;
  expect(full.coerceString()).toBe(String(enabled));
  const environment = { RUN_FULL_VALIDATION: full.coerceString() };
  const selected = gate.steps.filter((step) => {
    assert.ok(step.if, `Every gate step must select its full or waiting path: ${step.name}`);
    return expressionBoolean(step.if, scenario, environment);
  }).map(({ name }) => name);
  expect(selected).toEqual(enabled ? [
    "Setup Node", "Require every validation job", "Download test evidence", "Verify complete test inventory",
  ] : ["Explain unrequested validation"]);
}

function concurrencyGroup(scenario: CiScenario): string {
  return evaluateCiExpression(workflow.concurrency.group, scenario).value.coerceString();
}

function cancelsPrevious(scenario: CiScenario): boolean {
  return expressionBoolean(workflow.concurrency["cancel-in-progress"], scenario);
}

function executeRequiredJobsGate(results: Record<string, { result: string }>): void {
  const step = workflow.jobs.validate.steps.find(
    ({ name }) => name === "Require every validation job",
  );
  assert.ok(step?.run);
  const heredoc = /^node --input-type=module <<'NODE'\n([\s\S]+)\nNODE\s*$/u.exec(step.run);
  assert.ok(heredoc, "Execute the actual workflow Node program");
  const program = heredoc[1].replace(/^import assert from 'node:assert\/strict';\n/u, "");
  assert.notEqual(program, heredoc[1], "Only the assert import is supplied by the VM");
  runInNewContext(program, {
    assert,
    process: { env: { VALIDATION_NEEDS: JSON.stringify(results) } },
  }, { timeout: 1_000 });
}

describe("CI workflow execution policy", () => {
  it("subscribes to current PR changes, fresh label events and main pushes", () => {
    expect(workflow.on.pull_request.types).toEqual(["opened", "reopened", "synchronize", "labeled"]);
    expect(workflow.on.push.branches).toEqual(["main"]);
    expect([...workflow.jobs.validate.needs!].sort()).toEqual([...heavyJobs].sort());
    expect(Object.keys(workflow.jobs).sort()).toEqual([...heavyJobs, "validate"].sort());
  });

  it.each(["opened", "reopened", "synchronize"])(
    "private manual mode waits on %s without publishing a skipped validate check",
    (action) => assertValidationSelection({ action }, false),
  );

  it.each([undefined, "", "false"])("private repositories remain automatic for variable %s", (manual) => {
    for (const action of ["opened", "reopened", "synchronize"]) {
      assertValidationSelection({ manual, action }, true);
    }
  });

  it.each([undefined, "true", "false"])("public repositories remain automatic for variable %s", (manual) => {
    for (const action of ["opened", "reopened", "synchronize"]) {
      assertValidationSelection({ privateRepository: false, manual, action }, true);
    }
  });

  it("runs every validation job for a fresh private manual label request", () => {
    const request = { action: "labeled", label: "run-ci", labels: ["run-ci"] };
    assertValidationSelection(request, true);
  });

  it("does not reuse a sticky label as authorization for a new commit", () => {
    assertValidationSelection({ labels: ["run-ci"], sha: "new-commit" }, false);
  });

  it("isolates unrelated label events from full validation and its concurrency group", () => {
    const running = { action: "labeled", label: "run-ci", runId: 100 };
    const unrelated = { action: "labeled", label: "reviewed", labels: ["run-ci"], runId: 101 };
    assertValidationSelection(unrelated, false);
    expect(cancelsPrevious(unrelated)).toBe(false);
    expect(concurrencyGroup(unrelated)).not.toBe(concurrencyGroup(running));
    expect(concurrencyGroup({ ...unrelated, runId: 102 })).not.toBe(concurrencyGroup(unrelated));
  });

  it("does not turn label events into extra automatic runs", () => {
    for (const scenario of [{ privateRepository: false }, { manual: undefined }]) {
      const event = { ...scenario, action: "labeled", label: "run-ci" };
      assertValidationSelection(event, false, "ci-not-requested");
      expect(cancelsPrevious(event)).toBe(false);
    }
  });

  it.each([
    { action: "labeled", label: "run-ci" },
    { privateRepository: false },
    { manual: undefined },
  ])("only replaces full validations of the same PR merge SHA: %j", (mode) => {
    const first = { ...mode, sha: "merge-a", headSha: "same-head", runId: 100 };
    const duplicate = { ...first, runId: 101 };
    assertValidationSelection(first, true);
    expect(concurrencyGroup(duplicate)).toBe(concurrencyGroup(first));
    expect(cancelsPrevious(first)).toBe(true);
    expect(cancelsPrevious(duplicate)).toBe(true);
    expect(concurrencyGroup({ ...first, sha: "merge-b" })).not.toBe(concurrencyGroup(first));
    expect(concurrencyGroup({ ...first, pullRequest: 18 })).not.toBe(concurrencyGroup(first));
  });

  it("a delayed synchronize event cannot cancel a newer label-requested validation", () => {
    const requested = { action: "labeled", label: "run-ci", sha: "merge-b", runId: 101 };
    for (const sha of ["merge-a", "merge-b"]) {
      const delayed = { sha, runId: 100, labels: ["run-ci"] };
      assertValidationSelection(delayed, false);
      expect(cancelsPrevious(delayed)).toBe(false);
      expect(concurrencyGroup(delayed)).not.toBe(concurrencyGroup(requested));
    }
  });

  it("A to B to A waiting events retain independent groups without cancelling a full A run", () => {
    const running = { action: "labeled", label: "run-ci", sha: "merge-a", runId: 99 };
    const groups = ["merge-a", "merge-b", "merge-a"].map((sha, index) => {
      const waiting = { sha, runId: 100 + index, labels: ["run-ci"] };
      assertValidationSelection(waiting, false);
      expect(cancelsPrevious(waiting)).toBe(false);
      expect(concurrencyGroup(waiting)).not.toBe(concurrencyGroup(running));
      return concurrencyGroup(waiting);
    });
    expect(new Set(groups).size).toBe(3);
  });

  it("keeps every main commit automatic and in an independent concurrency group", () => {
    const main = { eventName: "push", ref: "refs/heads/main" };
    assertValidationSelection(main, true);
    assertValidationSelection({ ...main, privateRepository: false }, true);
    expect(cancelsPrevious(main)).toBe(false);
    expect(concurrencyGroup({ ...main, runId: 101 })).not.toBe(concurrencyGroup(main));
    assertValidationSelection({ ...main, ref: "refs/heads/feature" }, false);
  });
});

describe("actual CI validation gate program", () => {
  const passing = Object.fromEntries(heavyJobs.map((name) => [name, { result: "success" }]));

  it("accepts successful completion of every required job", () => {
    expect(() => executeRequiredJobsGate(passing)).not.toThrow();
  });

  it.each(["skipped", "failure", "cancelled"])("rejects a %s dependency", (result) => {
    for (const name of heavyJobs) {
      expect(() => executeRequiredJobsGate({ ...passing, [name]: { result } })).toThrow();
    }
  });

  it("rejects missing and unexpected dependencies", () => {
    for (const omitted of heavyJobs) {
      const incomplete = Object.fromEntries(Object.entries(passing).filter(([name]) => name !== omitted));
      expect(() => executeRequiredJobsGate(incomplete)).toThrow();
    }
    expect(() => executeRequiredJobsGate({ ...passing, extra: { result: "success" } })).toThrow();
  });
});
