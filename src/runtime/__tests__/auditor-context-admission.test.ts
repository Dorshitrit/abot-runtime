import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { runRequestRunner } from "../request/runner.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";
import {
  AUDIT_RUNNER_FINAL,
  AUDIT_RUNNER_PROMPT,
  auditFormatName,
  auditMessages,
  auditRootPrelude,
  createAuditorRunnerFixture,
  readAuditCapsule,
} from "./support/auditor-runner-fixture.js";

const ASSIGNMENT_KIND = "runtime_execution_agent_auditor_assignment_v1";
const STATE_KIND = "runtime_execution_state_v1";
type AuditAssignment = { auditId: string };
type RootAuditState = {
  auditAvailability: { workFingerprint: string };
  completedSubordinateResults: readonly {
    roleId: string;
    outcome: string;
    summary: string;
  }[];
};

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

test("closes the work snapshot when selected exact proof exceeds the Auditor context", async () => {
  let rootDecisions = 0;
  let selections = 0;
  let workFingerprint = "";
  const fixture = createAuditorRunnerFixture((input) => {
    if (input.modelStep === "execution.decision") {
      rootDecisions += 1;
      expect(
        auditMessages(input).filter(
          ({ role, content }) =>
            role === "user" && content === AUDIT_RUNNER_PROMPT,
        ),
      ).toHaveLength(1);
      if (rootDecisions <= 2) return auditRootPrelude(rootDecisions, 1);
      const state = readAuditCapsule<RootAuditState>(input, STATE_KIND);
      if (rootDecisions === 3) {
        workFingerprint = state.auditAvailability.workFingerprint;
        return auditRootPrelude(rootDecisions, 1);
      }
      expect(rootDecisions).toBe(4);
      expect(state.auditAvailability).toMatchObject({
        available: false,
        reason: "audit_finished_for_work",
        pendingEvidenceIds: null,
      });
      expect(state.completedSubordinateResults).toHaveLength(1);
      expect(JSON.stringify(input.format)).not.toContain('"invoke_auditor"');
      expect(JSON.stringify(input.format)).toContain('"respond"');
      expect(state.completedSubordinateResults[0]!.outcome).toBe("failed");
      const returned = state.completedSubordinateResults[0]!;
      expect(returned.roleId).toBe("reviewer");
      const receipt = JSON.parse(returned.summary) as Record<string, unknown>;
      expect(receipt.kind).toBe("runtime_execution_agent_auditor_advisory_v1");
      expect(receipt).toMatchObject({
        authority: "runtime_validation",
        verdict: "failed",
        evidenceBinding: {
          workFingerprint,
          selectedEvidenceIds: [fixture.records[0]!.executionId],
          bundleFingerprint: expect.any(String),
        },
      });
      expect(receipt.reason).toMatch(
        /^auditor_exact_context_(requires_compaction|exceeds_budget)$/u,
      );
      return { action: "respond" };
    }
    expect(input.modelStep).toBe("auditor.decision");
    expect(auditFormatName(input)).toBe("auditor_evidence_selection");
    selections += 1;
    const assignment = readAuditCapsule<AuditAssignment>(
      input,
      ASSIGNMENT_KIND,
    );
    return {
      auditId: assignment.auditId,
      selectedEvidenceIds: [fixture.records[0]!.executionId],
    };
  }, 1);
  const request = deriveTestRequestExecutionScope(fixture.request, {
    modelPolicy: {
      ...fixture.request.modelPolicy,
      profiles: {
        ...fixture.request.modelPolicy?.profiles,
        "audit-limited": {
          provider: "local",
          model: "audit-limited",
          contextWindowTokens: 6_000,
        },
      },
      defaults: {
        profileId: "audit-test",
        steps: { "auditor.decision": "audit-limited" },
      },
    },
  });
  await expect(runRequestRunner(request)).resolves.toMatchObject({
    output: AUDIT_RUNNER_FINAL,
  });
  expect(selections).toBe(1);
  expect(fixture.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
    "execution.decision",
    "execution.decision",
    "execution.decision",
    "auditor.decision",
    "execution.decision",
    "execution.response",
  ]);
  expect(fixture.execute).toHaveBeenCalledOnce();
  expect(fixture.invokeRaw).not.toHaveBeenCalled();
  expect(request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(
    AUDIT_RUNNER_FINAL,
  );
});
