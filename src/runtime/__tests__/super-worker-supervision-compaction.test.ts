import { expectCompactedSupervisionReference } from "./support/compacted-supervision-assertions.js";
import { afterEach, beforeEach, expect, test } from "vitest";
import { supervisorFormatName } from "./support/supervisor-model-phases.js";
import { createSemanticCompactionSha256Fingerprint } from "../context/semantic-compaction/contracts.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import {
  supervisionStagedFixture,
  STAGED_FACT,
  STAGED_RAW_MARKER,
} from "./support/supervision-staged-fixture.js";
beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(resetDebugLoggerConfig);

test.each([
  { label: "generic independent summary", registeredResult: undefined },
  {
    label: "registered output alias",
    registeredResult: "aliased-summary" as const,
  },
  {
    label: "registered independent summary",
    registeredResult: "independent-summary" as const,
  },
])(
  "S11/S12/S13: full SUPER chain preserves $label without widening Controls",
  async ({ registeredResult }) => {
    const f = supervisionStagedFixture("supervisor-worker-v1", {
      registeredResult,
    });
    await expect(f.run()).resolves.toMatchObject({ output: STAGED_FACT });
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(
      f.calls.filter(({ step }) => step === "context.compact"),
    ).toHaveLength(1);
    const stages: string[] = [];
    for (const call of f.calls) {
      const capsule = call.messages.flatMap(({ content }) => {
        try {
          const p = JSON.parse(content);
          return p.kind === "runtime_operation_supervision_evidence_v1"
            ? [p]
            : [];
        } catch {
          return [];
        }
      })[0];
      if (capsule) {
        stages.push(`${call.step}:${capsule.entries[0].notice.stage}`);
        expect(capsule.entries[0].evidence).toMatchObject({
          kind: "compacted_capability_result_reference",
          acceptedAction: { controls: { query: "same-observation" } },
        });
        expectCompactedSupervisionReference(
          call.messages,
          capsule.entries[0].evidence,
          "capability-execution-2",
          STAGED_FACT,
        );
        const evidence = capsule.entries[0].evidence;
        expect(JSON.stringify(capsule)).not.toContain(STAGED_RAW_MARKER);
        if (registeredResult) {
          expect(JSON.stringify(call.messages)).not.toContain(
            f.registeredOutput,
          );
          const source = f.request.contextCompactionStore!.materializeSource(
            evidence.sourceRef,
            evidence.sourceFingerprint,
          )!;
          expect(source.content).toContain(f.registeredOutput);
          expect(
            createSemanticCompactionSha256Fingerprint(source.content),
          ).toBe(evidence.sourceFingerprint);
          expect(JSON.parse(source.content).summary).toBe(
            registeredResult === "aliased-summary"
              ? f.registeredOutput
              : STAGED_FACT,
          );
        }
        if (registeredResult === "aliased-summary") {
          expect(evidence.receipt.summary).not.toBe(f.registeredOutput);
        } else {
          expect(evidence.receipt.summary).toBe(STAGED_FACT);
        }
        expect(
          f.counted.some(
            (counted) =>
              counted.step === call.step &&
              JSON.stringify(counted.messages) ===
                JSON.stringify(call.messages),
          ),
        ).toBe(true);
      }
      if (
        [
          "capability.controls",
          "planner.decision",
          "reviewer.decision",
          "supervisor.decision",
          "supervisor.response",
        ].includes(call.step)
      ) {
        expect(capsule).toBeUndefined();
      }
    }
    expect(stages).toEqual([
      "worker.decision:warning",
      "worker.decision:intervention",
      "worker.result:intervention",
    ]);
    expect(
      f.calls.filter(({ step }) => step === "capability.controls"),
    ).toHaveLength(3);
    expect(f.execute.mock.calls.map(([input]) => input.controls)).toEqual([
      { query: "same-observation" },
      { query: "same-observation" },
    ]);
    const chain = f.calls
      .map(({ step }) => step)
      .filter(
        (step) => !["context.compact", "capability.controls"].includes(step),
      );
    expect(chain).toEqual([
      "supervisor.decision",
      "supervisor.decision",
      "supervisor.decision",
      "supervisor.decision",
      "planner.decision",
      "worker.decision",
      "worker.decision",
      "worker.decision",
      "worker.decision",
      "worker.result",
      "planner.decision",
      "supervisor.decision",
      "reviewer.decision",
      "supervisor.decision",
      "supervisor.response",
    ]);
    expect(
      f.invoke.mock.calls
        .slice(0, 4)
        .map(([input]) => supervisorFormatName(input)),
    ).toEqual([
      "supervisor_presentation",
      "supervisor_procedure_gate",
      "supervisor_delegation",
      "supervisor_working_directory",
    ]);
    expect(
      f.calls
        .find(({ step }) => step === "reviewer.decision")!
        .messages.map(({ content }) => content)
        .join("\n"),
    ).toContain("report.txt");
  },
);
