import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import { createRequestSteeringInbox } from "../request/request-steering.js";
import { runRequestRunner } from "../request/runner.js";
import {
  createRootInvalidOutputRequest,
  ROOT_OUTPUT_POLICIES,
  rootRespondOutput,
} from "./support/root-invalid-output-fixture.js";

const FIRST_UPDATE = "Use the updated request direction.";
const SECOND_UPDATE = "Apply the latest direction instead.";
const PHRASING = {
  failureNotice: "The current model response stopped before completion.",
  nextStep: "Continue from the established state in a follow-up request.",
};
const DEGRADED_OUTPUT = `${PHRASING.failureNotice}\n\n${PHRASING.nextStep}`;
const FRESH_OUTPUT = "The answer follows the latest request direction.";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

describe.each(ROOT_OUTPUT_POLICIES)(
  "$policyId incomplete output after steering retry",
  (policy) => {
    test.each(["decision", "response"] as const)(
      "finalizes incomplete %s from the internally retried request version",
      async (phase) => {
        const steering = createRequestSteeringInbox({
          requestId: "root-invalid-request",
        });
        const steps = [
          policy.decisionStep,
          policy.decisionStep,
          ...(phase === "response" ? [policy.responseStep] : []),
          "degraded.finalization",
        ];
        let next = 0;
        const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
          expect(input.modelStep).toBe(steps[next++]);
          if (next === 1) {
            expect(steering.snapshot().version).toBe(0);
            expect(
              steering.append({ steerId: "first", text: FIRST_UPDATE }).ok,
            ).toBe(true);
            return { text: rootRespondOutput(policy.policyId), meta: {} };
          }
          expect(steering.snapshot().version).toBe(1);
          expect(JSON.stringify(input.messages)).toContain(FIRST_UPDATE);
          if (input.modelStep === "degraded.finalization")
            return { text: JSON.stringify(PHRASING), meta: {} };
          if (phase === "response" && input.modelStep === policy.decisionStep)
            return { text: rootRespondOutput(policy.policyId), meta: {} };
          return {
            text: "UNTRUSTED_CURRENT_PARTIAL_OUTPUT",
            meta: { providerCompletionReason: "length", steeringVersion: 99 },
          };
        });
        const request = createRootInvalidOutputRequest(
          invoke,
          policy.policyId,
          {
            requestSteering: steering,
          },
        );

        const result = await runRequestRunner(request);

        expect(result.output).toBe(DEGRADED_OUTPUT);
        expect(result.finalObservation).toBeUndefined();
        expect(result.memoryCandidates).toBeUndefined();
        expect(next).toBe(steps.length);
        expect(request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(
          DEGRADED_OUTPUT,
        );
        expect(
          steering.append({ steerId: "too-late", text: SECOND_UPDATE }),
        ).toEqual({
          ok: false,
          reason: "request_not_active",
        });
        expect(steering.snapshot().version).toBe(1);
      },
    );

    test("discards degraded framing when a later update arrives during its generation", async () => {
      const steering = createRequestSteeringInbox({
        requestId: "root-invalid-request",
      });
      const steps = [
        policy.decisionStep,
        policy.decisionStep,
        "degraded.finalization",
        policy.decisionStep,
        policy.responseStep,
      ];
      let next = 0;
      const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
        expect(input.modelStep).toBe(steps[next++]);
        if (next === 1) {
          expect(
            steering.append({ steerId: "first", text: FIRST_UPDATE }).ok,
          ).toBe(true);
          return { text: rootRespondOutput(policy.policyId), meta: {} };
        }
        if (next === 2) {
          expect(JSON.stringify(input.messages)).toContain(FIRST_UPDATE);
          return {
            text: "CURRENT_PARTIAL_OUTPUT",
            meta: { providerCompletionReason: "length" },
          };
        }
        if (input.modelStep === "degraded.finalization") {
          expect(steering.snapshot().version).toBe(1);
          expect(
            steering.append({ steerId: "second", text: SECOND_UPDATE }).ok,
          ).toBe(true);
          return { text: JSON.stringify(PHRASING), meta: {} };
        }
        expect(steering.snapshot().version).toBe(2);
        expect(JSON.stringify(input.messages)).toContain(SECOND_UPDATE);
        return {
          text:
            input.modelStep === policy.decisionStep
              ? rootRespondOutput(policy.policyId)
              : FRESH_OUTPUT,
          meta: {},
        };
      });
      const request = createRootInvalidOutputRequest(invoke, policy.policyId, {
        requestSteering: steering,
      });

      const result = await runRequestRunner(request);

      expect(result.output).toBe(FRESH_OUTPUT);
      expect(next).toBe(steps.length);
      expect(request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(
        FRESH_OUTPUT,
      );
      expect(JSON.stringify(result)).not.toContain(PHRASING.failureNotice);
      expect(steering.snapshot().version).toBe(2);
      expect(
        steering.append({ steerId: "too-late", text: "Late update." }),
      ).toEqual({
        ok: false,
        reason: "request_not_active",
      });
    });

    test("discards an incomplete attempt superseded before output acceptance", async () => {
      const steering = createRequestSteeringInbox({
        requestId: "root-invalid-request",
      });
      const steps = [
        policy.decisionStep,
        policy.decisionStep,
        policy.responseStep,
      ];
      let next = 0;
      const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
        expect(input.modelStep).toBe(steps[next++]);
        if (next === 1) {
          expect(
            steering.append({ steerId: "first", text: FIRST_UPDATE }).ok,
          ).toBe(true);
          return {
            text: "SUPERSEDED_PARTIAL_OUTPUT",
            meta: { providerCompletionReason: "length" },
          };
        }
        expect(JSON.stringify(input.messages)).toContain(FIRST_UPDATE);
        return {
          text:
            input.modelStep === policy.decisionStep
              ? rootRespondOutput(policy.policyId)
              : FRESH_OUTPUT,
          meta: {},
        };
      });
      const request = createRootInvalidOutputRequest(invoke, policy.policyId, {
        requestSteering: steering,
      });

      const result = await runRequestRunner(request);

      expect(result.output).toBe(FRESH_OUTPUT);
      expect(next).toBe(steps.length);
      expect(request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(
        FRESH_OUTPUT,
      );
      expect(steering.snapshot().version).toBe(1);
    });
  },
);
