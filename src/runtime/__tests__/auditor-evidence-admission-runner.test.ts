import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type { WorkerCapabilityAdapter } from "../orchestration/worker-capabilities/index.js";
import type { RequestCapabilityExecutionView } from "../request/execution-scope.js";
import { runRequestRunner } from "../request/runner.js";
import {
  AUDIT_CRITERION_IDS,
  AUDIT_RUNNER_FINAL,
  auditFormatName,
  createAuditorRunnerFixture,
  readAuditCapsule,
  type AuditRunnerInput,
} from "./support/auditor-runner-fixture.js";
import { WORK_PLAN_GRAPH } from "./support/model-work-plan-source-fixture.js";
import { createTestRequestExecutionScope } from "./support/request-execution-scope.js";

const STATE = "runtime_execution_state_v1";
const ASSIGNMENT = "runtime_execution_agent_auditor_assignment_v1";
const INVENTORY = "runtime_execution_agent_auditor_inventory_v1";
const EVIDENCE = "runtime_execution_agent_auditor_evidence_v1";
const COUNT = 18;
type Receipt = {
  verdict: string;
  reason?: string;
  requestedEvidenceIds?: string[];
  evidenceBinding: { selectedEvidenceIds: string[]; workFingerprint: string };
};
type RootState = {
  auditAvailability: {
    available: boolean;
    reason: string;
    pendingEvidenceIds: string[] | null;
  };
  completedSubordinateResults: { roleId: string; summary: string }[];
};
type Proof = {
  evidence: { executionId: string; adapterResult: unknown }[];
  evidenceProjection: { complete: boolean; omittedEvidenceCount: number };
};
function registeredWrites() {
  return Array.from({ length: COUNT }, (_, index) => {
    const path = `artifact-${index + 1}.txt`;
    const body =
      `EXACT_WRITE_${index + 1}:` + "x".repeat(index < 3 ? 17_000 : 1_000);
    const references = [{ kind: "tool_target" as const, target: path }];
    return {
      executionId: `capability-execution-${index + 1}`,
      path,
      body,
      exactResult: {
        kind: "registered_tool_execution_result_v1" as const,
        authority: "registered_plugin" as const,
        status: "executed" as const,
        references,
        result: {
          ok: true,
          tool: "fixture.write",
          output: `Wrote ${path}.`,
          producedNewInformation: true,
          actions: [{ type: "write_file", target: path }],
          data: { mutationEvidence: true, mutationGrounding: body },
        },
      },
    };
  });
}
function createCase(mode: "all" | "expand" | "limited") {
  const records = registeredWrites();
  const ids = records.map(({ executionId }) => executionId);
  const execute = vi.fn<
    WorkerCapabilityAdapter<RequestCapabilityExecutionView>["execute"]
  >(async ({ controls }) => {
    const record = records.find(({ path }) => path === controls.path)!;
    return {
      outcome: "succeeded",
      observedEffect: "mutation",
      summary: record.exactResult.result.output,
      referenceData: record.body,
      references: record.exactResult.references,
      exactResult: record.exactResult,
    };
  });
  const adapter: WorkerCapabilityAdapter<RequestCapabilityExecutionView> = {
    descriptor: {
      capabilityId: "fixture.write",
      summary: "Write one requested artifact.",
      effect: "mutation",
      controls: {
        type: "object",
        additionalProperties: false,
        properties: { path: { type: "string", minLength: 1, maxLength: 128 } },
        required: ["path"],
      },
      selectionControlIds: ["path"],
      controlsRefinement: "mechanical_when_complete",
      catalogGroups: ["files"],
    },
    execute,
  };
  let rootDecisions = 0;
  let selections = 0;
  let reviews = 0;
  let finalState: RootState | undefined;
  const requestedBundles: string[][] = [];
  const fixture = createAuditorRunnerFixture((input: AuditRunnerInput) => {
    if (input.modelStep === "planner.graph") return WORK_PLAN_GRAPH;
    if (input.modelStep === "execution.decision") {
      rootDecisions += 1;
      if (rootDecisions === 1)
        return {
          action: "open_capability_scope",
          catalogGroupIds: ["files"],
          acknowledgement:
            "I will plan, write the artifacts, and audit completion.",
        };
      if (rootDecisions === 2)
        return {
          action: "invoke_planner",
          objective: "Propose the requested artifact writes and audit.",
        };
      const state = readAuditCapsule<RootState>(input, STATE);
      expect(state.completedSubordinateResults[0]!.roleId).toBe("planner");
      expect(
        JSON.parse(state.completedSubordinateResults[0]!.summary).kind,
      ).toBe("runtime_execution_agent_planner_advisory_v1");
      const record = records[rootDecisions - 3];
      if (record)
        return {
          action: "invoke_capability",
          capabilityId: "fixture.write",
          intent: `Write ${record.path}.`,
          selectionControls: { path: record.path },
          ...(rootDecisions === 3 ? { workingDirectory: "." } : {}),
        };
      if (rootDecisions === COUNT + 3)
        return {
          action: "invoke_auditor",
          criterionIds: AUDIT_CRITERION_IDS,
        };
      const receipt = JSON.parse(
        state.completedSubordinateResults.at(-1)!.summary,
      ) as Receipt;
      if (receipt.verdict === "needs_evidence") {
        expect(state.auditAvailability).toMatchObject({
          available: true,
          reason: "auditor_requested_evidence",
          pendingEvidenceIds: ids,
        });
        requestedBundles.push(receipt.requestedEvidenceIds!);
        return { action: "invoke_auditor", criterionIds: AUDIT_CRITERION_IDS };
      }
      finalState = state;
      expect(JSON.stringify(input.format)).not.toContain('"invoke_auditor"');
      return { action: "respond" };
    }
    expect(input.modelStep).toBe("auditor.decision");
    const assignment = readAuditCapsule<{ auditId: string }>(input, ASSIGNMENT);
    const inventory = readAuditCapsule<{
      inventory: { executionId: string }[];
    }>(input, INVENTORY);
    expect(inventory.inventory.map(({ executionId }) => executionId)).toEqual(
      ids,
    );
    expect(JSON.stringify(inventory)).not.toContain("planner_advisory");
    if (auditFormatName(input) === "auditor_evidence_selection") {
      selections += 1;
      return {
        auditId: assignment.auditId,
        selectedEvidenceIds: mode === "expand" ? ids.slice(0, 3) : ids,
      };
    }
    expect(auditFormatName(input)).toBe("auditor_decision");
    reviews += 1;
    const proof = readAuditCapsule<Proof>(input, EVIDENCE);
    const selected =
      mode === "expand" && reviews === 1 ? records.slice(0, 3) : records;
    expect(proof.evidence.map(({ executionId }) => executionId)).toEqual(
      selected.map(({ executionId }) => executionId),
    );
    expect(proof.evidence.map(({ adapterResult }) => adapterResult)).toEqual(
      selected.map(({ exactResult }) => exactResult),
    );
    expect(proof.evidenceProjection).toMatchObject({
      complete: true,
      omittedEvidenceCount: 0,
    });
    expect(JSON.stringify(proof.evidence).length).toBeGreaterThan(48_000);
    for (const record of selected) {
      expect(JSON.stringify(proof).split(record.body)).toHaveLength(2);
    }
    const needs = mode === "expand" && reviews === 1;
    return {
      auditId: assignment.auditId,
      verdict: needs ? "needs_evidence" : "pass",
      criterionIds: AUDIT_CRITERION_IDS,
      gaps: needs
        ? [
            {
              criterionId: AUDIT_CRITERION_IDS[0],
              description:
                "Review all remaining writes with the current originals.",
            },
          ]
        : [],
      neededEvidenceIds: ids,
      notNeededEvidenceIds: [],
      requestedEvidenceIds: needs ? ids : [],
    };
  });
  const request = createTestRequestExecutionScope({
    ...fixture.request,
    prompt:
      "Write the eighteen supplied artifacts, then audit their completed writes.",
    runnerConfig: {
      ...fixture.request.runnerConfig,
      steps: {
        ...fixture.request.runnerConfig.steps,
        "planner.graph": { timeoutMs: 20_000 },
      },
    },
    workerCapabilityProvider: {
      getDescriptors: () => [adapter.descriptor],
      getAdapters: () => [adapter],
    },
    ...(mode === "limited"
      ? {
          modelPolicy: {
            ...fixture.request.modelPolicy,
            profiles: {
              ...fixture.request.modelPolicy?.profiles,
              "limited-auditor": {
                provider: "local",
                model: "limited-auditor",
                contextWindowTokens: 18_000,
              },
            },
            defaults: {
              profileId: "audit-test",
              steps: { "auditor.decision": "limited-auditor" },
            },
          },
        }
      : {}),
  });
  return {
    ...fixture,
    request,
    records,
    ids,
    execute,
    requestedBundles,
    counts: () => ({ selections, reviews }),
    finalState: () => finalState!,
  };
}

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

describe("Auditor admission uses configured context for complete registered proof", () => {
  test.each(["all", "expand"] as const)(
    "admits %s whole bundle through Planner, writes, Auditor, and root",
    async (mode) => {
      const fixture = createCase(mode);
      await expect(runRequestRunner(fixture.request)).resolves.toMatchObject({
        output: AUDIT_RUNNER_FINAL,
      });
      const state = fixture.finalState();
      const receipts = state.completedSubordinateResults
        .slice(1)
        .map(({ summary }) => JSON.parse(summary) as Receipt);
      expect(
        receipts.map(({ verdict, reason }) => ({ verdict, reason })),
      ).toEqual(
        mode === "expand"
          ? [
              { verdict: "needs_evidence", reason: undefined },
              { verdict: "pass", reason: undefined },
            ]
          : [{ verdict: "pass", reason: undefined }],
      );
      expect(receipts.at(-1)!.evidenceBinding.selectedEvidenceIds).toEqual(
        fixture.ids,
      );
      expect(
        new Set(
          receipts.map(
            ({ evidenceBinding }) => evidenceBinding.workFingerprint,
          ),
        ).size,
      ).toBe(1);
      expect(state.auditAvailability).toMatchObject({
        available: false,
        reason: "audit_finished_for_work",
        pendingEvidenceIds: null,
      });
      expect(fixture.counts()).toEqual({
        selections: 1,
        reviews: mode === "expand" ? 2 : 1,
      });
      expect(fixture.requestedBundles).toEqual(
        mode === "expand" ? [fixture.ids] : [],
      );
      expect(fixture.execute).toHaveBeenCalledTimes(COUNT);
      const steps = fixture.invoke.mock.calls.map(([input]) => input.modelStep);
      expect(steps.filter((step) => step === "planner.graph")).toHaveLength(1);
      expect(steps.filter((step) => step === "auditor.decision")).toHaveLength(
        mode === "expand" ? 3 : 2,
      );
      expect(fixture.request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(
        AUDIT_RUNNER_FINAL,
      );
    },
  );

  test("returns one honest failure when configured exact context cannot admit valid selected IDs", async () => {
    const fixture = createCase("limited");
    await expect(runRequestRunner(fixture.request)).resolves.toMatchObject({
      output: AUDIT_RUNNER_FINAL,
    });
    const state = fixture.finalState();
    const receipt = JSON.parse(
      state.completedSubordinateResults.at(-1)!.summary,
    ) as Receipt;
    expect(receipt).toMatchObject({
      verdict: "failed",
      evidenceBinding: { selectedEvidenceIds: fixture.ids },
    });
    expect(receipt.reason).toMatch(
      /^auditor_exact_context_(requires_compaction|exceeds_budget)$/u,
    );
    expect(state.auditAvailability).toMatchObject({
      available: false,
      reason: "audit_finished_for_work",
    });
    expect(fixture.counts()).toEqual({ selections: 1, reviews: 0 });
    expect(
      fixture.invoke.mock.calls.filter(
        ([input]) => input.modelStep === "auditor.decision",
      ),
    ).toHaveLength(1);
  });
});
