import { expectCompactedSupervisionReference } from "./support/compacted-supervision-assertions.js";
import { afterEach, beforeEach, expect, test } from "vitest";
import { validateModelGatewayMessages } from "../../model-gateway/message-contract.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import {
  supervisionStagedFixture,
  STAGED_FACT,
} from "./support/supervision-staged-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(resetDebugLoggerConfig);

test.each([undefined, "aliased-summary", "independent-summary"] as const)(
  "S01/S02/S09/S10: EA warning, repeated intervention and response reuse the same verified source digest (%s)",
  async (registeredResult) => {
    const f = supervisionStagedFixture("execution-agent-v1", {
      registeredResult,
    });
    await expect(f.run()).resolves.toMatchObject({ output: STAGED_FACT });
    expect(f.execute).toHaveBeenCalledTimes(2);
    const compactCalls = f.calls.filter(
      ({ step }) => step === "context.compact",
    );
    expect(compactCalls).toHaveLength(1);
    // Protected notices never enter the compactor, even when their native results do.
    expect(JSON.stringify(compactCalls)).not.toContain(
      "runtime_operation_supervision_evidence_v1",
    );
    const notices: string[] = [];
    for (const call of f.calls) {
      validateModelGatewayMessages(call.messages);
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
      if (!capsule) continue;
      notices.push(`${call.step}:${capsule.entries[0].notice.stage}`);
      expect(
        call.messages.filter(
          ({ role, content }) =>
            role === "user" && content === f.request.prompt,
        ),
      ).toHaveLength(1);
      expect(
        call.messages.some(
          ({ content }) =>
            content === "Earlier research: inspect sources first.",
        ),
      ).toBe(true);
      if (call.step === "execution.decision")
        expect(
          call.messages.some(({ content }) =>
            content.includes("2026-10-02 21:00:00 GMT+03:00"),
          ),
        ).toBe(true);
      expect(capsule.entries[0].evidence).toMatchObject({
        kind: "compacted_capability_result_reference",
        acceptedAction: {
          executionId: "capability-execution-2",
          controls: { query: "same-observation" },
        },
        receipt: { executionId: "capability-execution-2" },
      });
      expectCompactedSupervisionReference(
        call.messages,
        capsule.entries[0].evidence,
        "tool-result:capability-execution-2",
        STAGED_FACT,
      );
      if (registeredResult) {
        expect(JSON.stringify(call.messages)).not.toContain(f.registeredOutput);
        const stored = f.request.contextCompactionStore!.materializeSource(
          capsule.entries[0].evidence.sourceRef,
          capsule.entries[0].evidence.sourceFingerprint,
        );
        expect(stored!.content).toContain(f.registeredOutput);
      }
      if (registeredResult === "independent-summary")
        expect(capsule.entries[0].evidence.receipt.summary).toBe(STAGED_FACT);
      expect(call.messages.filter(({ role }) => role === "tool")).toHaveLength(
        0,
      );
      expect(
        f.counted.some(
          (measured) =>
            measured.step === call.step &&
            JSON.stringify(measured.messages) === JSON.stringify(call.messages),
        ),
      ).toBe(true);
    }
    expect(notices).toEqual([
      "execution.decision:warning",
      "execution.decision:intervention",
      "execution.response:intervention",
    ]);
    expect(
      f.calls.filter(({ step }) => step === "capability.controls"),
    ).toEqual([]);
  },
);

test("S09: an oversized protected exact original cannot commit a candidate or dispatch the decision", async () => {
  const f = supervisionStagedFixture("execution-agent-v1", { oversized: true });
  await expect(f.run()).rejects.toThrow(/context_compaction/);
  expect(f.execute).toHaveBeenCalledTimes(2);
  expect(
    f.calls.filter(({ step }) => step === "execution.decision"),
  ).toHaveLength(3);
  expect(
    f.request.contextCompactionStore!.get(
      "role:supervisor:call-1:continuation",
    ),
  ).toBeUndefined();
  expect(
    f.calls.filter(({ step }) => step === "execution.response"),
  ).toHaveLength(0);
});

test("S09: estimator-only admission counts the protected exact original after compaction", async () => {
  const f = supervisionStagedFixture("execution-agent-v1", { estimated: true });
  await expect(f.run()).resolves.toMatchObject({ output: STAGED_FACT });
  expect(f.execute).toHaveBeenCalledTimes(2);
  expect(f.calls.some(({ step }) => step === "context.compact")).toBe(true);
  const projected = f.calls
    .filter(({ step }) => step === "execution.decision")
    .at(-1)!;
  expect(JSON.stringify(projected.messages)).toContain("embedded_exact_result");
  const snapshot = f.events
    .filter(
      ({ name, data }) =>
        name === "context.window.snapshot" &&
        data?.modelStep === "execution.decision",
    )
    .at(-1)!;
  expect(snapshot.data).toMatchObject({
    measurement: "estimated",
    admissionOutcome: "accepted",
  });
  expect(Number(snapshot.data?.estimatedInputTokens)).toBeLessThan(22400);
});
