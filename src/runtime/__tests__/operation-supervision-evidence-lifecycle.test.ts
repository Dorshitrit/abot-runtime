import { expectCompactedSupervisionReference } from "./support/compacted-supervision-assertions.js";
import {
  captureRequestContextCompaction,
  restoreRequestContextCompaction,
} from "../context/semantic-compaction/snapshot.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { runRequestRunner } from "../request/runner.js";
import {
  supervisionApprovalFixture,
  CONTROLS_APPROVAL_FINGERPRINT,
} from "./support/supervision-approval-fixture.js";
import { supervisionStagedFixture } from "./support/supervision-staged-fixture.js";
import { readEvidence } from "./support/supervision-closure-fixture.js";
beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(resetDebugLoggerConfig);

test("S14: warning compaction then ASK reload resumes exactly one approved prepared action", async () => {
  const f = supervisionApprovalFixture();
  const initial = f.makeRequest();
  const waiting = await runRequestRunner(initial, { durableApproval: true });
  if (waiting.kind !== "awaiting_approval")
    throw new Error("expected_prepared_approval");
  expect(f.sourceExecute).toHaveBeenCalledTimes(2);
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(f.performed).not.toHaveBeenCalled();
  expect(f.calls.filter(({ step }) => step === "context.compact")).toHaveLength(
    1,
  );
  const warning = f.calls.find(
    ({ step, messages }) =>
      step === "execution.decision" && readEvidence(messages).length,
  )!;
  expectCompactedSupervisionReference(
    warning.messages,
    readEvidence(warning.messages)[0].entries[0].evidence,
    "tool-result:capability-execution-2",
  );
  const checkpoint = initial.contextCompactionStore!.snapshot!();
  expect(checkpoint.checkpoints).toHaveLength(1);
  const persisted = JSON.parse(JSON.stringify(waiting.continuation));
  expect(JSON.stringify(persisted)).not.toContain(
    "currentOperationSupervisionAuthority",
  );
  const controlsBefore = f.calls.filter(
    ({ step }) => step === "capability.controls",
  ).length;
  // The request park/reload owner persists compaction separately from runner continuation.
  const persistedCompaction = JSON.parse(
    JSON.stringify(
      captureRequestContextCompaction(initial.contextCompactionStore!),
    ),
  );
  const resumed = deriveTestRequestExecutionScope(f.makeRequest(), {
    contextCompactionStore:
      restoreRequestContextCompaction(persistedCompaction),
  });
  await expect(
    runRequestRunner(resumed, {
      durableApproval: true,
      continuation: persisted,
      decisions: [
        {
          approvalId: "controls-exact-approval",
          actionFingerprint: CONTROLS_APPROVAL_FINGERPRINT,
          decision: { approved: true },
        },
      ],
    }),
  ).resolves.toMatchObject({
    kind: "completed",
    result: { output: "The request settled." },
  });
  expect(f.restore).toHaveBeenCalledOnce();
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(f.sourceExecute).toHaveBeenCalledTimes(2);
  expect(
    f.calls.filter(({ step }) => step === "capability.controls"),
  ).toHaveLength(controlsBefore);
  expect(f.performed).toHaveBeenCalledExactlyOnceWith(
    "capability-execution-3",
    { target: "chosen/report.txt" },
  );
  expect(f.calls.filter(({ step }) => step === "context.compact")).toHaveLength(
    1,
  );
  // Settling the approved mutation expires the earlier immediate notice.
  const finalDecision = f.calls
    .filter(({ step }) => step === "execution.decision")
    .at(-1)!;
  expect(readEvidence(finalDecision.messages)).toHaveLength(0);
  const restoredCheckpoint = finalDecision.messages
    .map(({ content }) => {
      try {
        return JSON.parse(content);
      } catch {
        return undefined;
      }
    })
    .find(
      (value) => value?.kind === "runtime_semantic_compaction_checkpoint_v2",
    );
  expect(restoredCheckpoint).toMatchObject({
    scopeId: checkpoint.checkpoints[0]!.scopeId,
    sourceRevision: checkpoint.checkpoints[0]!.sourceRevision,
    coveredSources: checkpoint.checkpoints[0]!.sourceDigests,
  });
});

test("S15: cancellation during protected-evidence compaction does not commit or dispatch the waiting decision", async () => {
  const f = supervisionStagedFixture("execution-agent-v1", {
    abortDuringCompaction: true,
  });
  await expect(f.run()).rejects.toThrow("cancel_supervision_compaction");
  expect(f.execute).toHaveBeenCalledTimes(2);
  expect(
    f.request.contextCompactionStore!.snapshot!().checkpoints,
  ).toHaveLength(0);
  expect(
    f.calls.filter(({ step }) => step === "execution.decision"),
  ).toHaveLength(3);
  expect(
    f.calls.filter(({ step }) => step === "execution.response"),
  ).toHaveLength(0);
});
