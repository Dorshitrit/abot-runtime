import { describe, expect, test } from "vitest";

import type { CapabilityAdapterResult } from "../orchestration/capability-adapters/result.js";
import { createRegisteredToolWorkerFailureOutcomeFingerprint } from "../adapters/registered-tool-worker-capabilities/failure-outcome-fingerprint.js";

describe("registered-tool Worker failure outcome fingerprints", () => {
  test("combines errorCode and exitCode without allowing either to hide the other", () => {
    const exitOne = fingerprint({ errorCode: " command_failed ", exitCode: 1 });
    const exitTwo = fingerprint({ errorCode: "command_failed", exitCode: 2 });
    const sameExitOne = fingerprint({
      errorCode: "command_failed",
      exitCode: 1,
    });

    expect(exitOne).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(exitTwo).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(exitTwo).not.toBe(exitOne);
    expect(sameExitOne).toBe(exitOne);
  });

  test("keeps errorCode-only and exitCode-only identities stable", () => {
    const errorOnly = fingerprint({ errorCode: "permission_denied" });
    const sameErrorOnly = fingerprint({ errorCode: "permission_denied" });
    const exitOnly = fingerprint({ exitCode: 126 });
    const sameExitOnly = fingerprint({ exitCode: 126 });

    expect(errorOnly).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(errorOnly).toBe(sameErrorOnly);
    expect(exitOnly).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(exitOnly).toBe(sameExitOnly);
    expect(exitOnly).not.toBe(errorOnly);
  });

  test("fails open when canonical fallback input is unsafe", () => {
    const unsafe = {
      kind: "generic_capability_result_v1",
      authority: "capability_adapter",
      status: "executed",
      ok: false,
      payload: 1n,
    } as unknown as CapabilityAdapterResult;

    expect(
      createRegisteredToolWorkerFailureOutcomeFingerprint(unsafe),
    ).toBeNull();
  });
});

function fingerprint(input: {
  errorCode?: string;
  exitCode?: number;
}): string | null {
  return createRegisteredToolWorkerFailureOutcomeFingerprint(
    registeredToolFailure(input),
  );
}

function registeredToolFailure(input: {
  errorCode?: string;
  exitCode?: number;
}): CapabilityAdapterResult {
  return Object.freeze({
    kind: "registered_tool_execution_result_v1" as const,
    authority: "registered_plugin" as const,
    status: "executed" as const,
    result: Object.freeze({
      ok: false,
      tool: "shell.execute",
      output: "Command failed.",
      producedNewInformation: false,
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
    }),
  });
}
