import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import {
  createRoleCallLedger,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
  type ExecutionPolicyAuthoritySnapshot,
  type RoleCallFrame,
  type RoleCallLedger,
} from "../orchestration/role-calls/index.js";
import {
  createRoleCapabilityBinding,
  type WorkerCapabilityAdapter,
  type WorkerCapabilityAdapterResult,
  type WorkerCapabilityControls,
  type WorkerCapabilityDescriptor,
} from "../orchestration/worker-capabilities/index.js";
import { createWorkerCapabilityPreparationFailureFingerprint } from "../orchestration/worker-capabilities/preparation-fingerprint.js";

type TestContext = Readonly<{ owner: "root" | "worker" }>;
type Owner = TestContext["owner"];

const observationDescriptor: WorkerCapabilityDescriptor = Object.freeze({
  capabilityId: "files.read_range",
  summary: "Read one exact range from a selected file.",
  effect: "observation",
  controls: Object.freeze({
    type: "object" as const,
    additionalProperties: false as const,
    properties: Object.freeze({
      path: Object.freeze({
        type: "string" as const,
        minLength: 1,
        maxLength: 4_096,
      }),
      startLine: Object.freeze({
        type: "integer" as const,
        minimum: 1,
        maximum: 1_000_000,
      }),
      endLine: Object.freeze({
        type: "integer" as const,
        minimum: 1,
        maximum: 1_000_000,
      }),
    }),
    required: Object.freeze(["path", "startLine", "endLine"]),
  }),
  selectionControlIds: Object.freeze(["path"]),
  catalogGroups: Object.freeze(["files"]),
});
const alternateObservationDescriptor: WorkerCapabilityDescriptor =
  Object.freeze({
    ...observationDescriptor,
    capabilityId: "files.inspect_range",
    summary: "Inspect one exact range from a selected file.",
  });

const FIRST_RANGE = Object.freeze({
  path: "project/index.html",
  startLine: 1,
  endLine: 20,
});
const SECOND_RANGE = Object.freeze({
  path: "project/index.html",
  startLine: 21,
  endLine: 40,
});

beforeEach(() => {
  configureDebugLogger({ enabled: false });
});

afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

describe("shared exact-operation supervision", () => {
  test.each(["root", "worker"] as const)(
    "warns, intervenes without execution, then rejects persistent repetition for %s",
    async (owner) => {
      const fixture = await createFixture(owner);

      await expect(executeObservation(fixture, FIRST_RANGE)).resolves.toEqual({
        executionId: "capability-execution-1",
      });
      await expect(executeObservation(fixture, FIRST_RANGE)).resolves.toEqual({
        executionId: "capability-execution-2",
      });
      expect(fixture.externalExecute).toHaveBeenCalledTimes(2);
      expect(
        fixture.ledger.current().state.operationSupervision.entries,
      ).toEqual([
        expect.objectContaining({
          stage: "warning",
          priorOutcome: "succeeded",
          matchingOutcomeCount: 2,
          originExecutionId: "capability-execution-2",
        }),
      ]);

      await expect(
        executeObservation(fixture, FIRST_RANGE),
      ).resolves.toMatchObject({
        kind: "operation_supervision_intervened",
        commit: {
          effect: {
            type: "operation_supervision_intervened",
            originExecutionId: "capability-execution-2",
          },
        },
      });
      expect(fixture.externalExecute).toHaveBeenCalledTimes(2);
      expect(fixture.ledger.current().state.capabilityExecutions).toHaveLength(
        2,
      );

      const beforeRejection = fixture.ledger.current();
      await expect(executeObservation(fixture, FIRST_RANGE)).rejects.toThrow(
        "worker_capability_begin_rejected:operation_supervision_limit_exceeded",
      );
      expect(fixture.externalExecute).toHaveBeenCalledTimes(2);
      expect(fixture.ledger.current()).toBe(beforeRejection);
    },
  );

  test("tracks A/B/A request-wide without treating different ranges as duplicates", async () => {
    const fixture = await createFixture("worker");

    await executeObservation(fixture, FIRST_RANGE);
    await executeObservation(fixture, SECOND_RANGE);
    await executeObservation(fixture, FIRST_RANGE);

    expect(fixture.externalExecute).toHaveBeenCalledTimes(3);
    expect(fixture.ledger.current().state.operationSupervision.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionFingerprint: fingerprint(FIRST_RANGE),
          stage: "warning",
          matchingOutcomeCount: 2,
        }),
        expect.objectContaining({
          actionFingerprint: fingerprint(SECOND_RANGE),
          stage: "tracking",
          matchingOutcomeCount: 1,
        }),
      ]),
    );
  });

  test("uses stable failure identity and does not merge different failure codes", async () => {
    const results = [
      failedResult("read_timeout"),
      failedResult("permission_denied"),
      failedResult("permission_denied"),
    ];
    const fixture = await createFixture("worker", () => results.shift()!);

    await executeObservation(fixture, FIRST_RANGE);
    await executeObservation(fixture, FIRST_RANGE);
    expect(
      fixture.ledger.current().state.operationSupervision.entries[0],
    ).toMatchObject({ stage: "tracking", matchingOutcomeCount: 1 });

    await executeObservation(fixture, FIRST_RANGE);
    expect(
      fixture.ledger.current().state.operationSupervision.entries[0],
    ).toMatchObject({
      stage: "warning",
      priorOutcome: "failed",
      matchingOutcomeCount: 2,
      originExecutionId: "capability-execution-3",
    });
    expect(fixture.externalExecute).toHaveBeenCalledTimes(3);

    await expect(
      executeObservation(fixture, FIRST_RANGE),
    ).resolves.toMatchObject({
      kind: "operation_supervision_intervened",
    });
    expect(fixture.externalExecute).toHaveBeenCalledTimes(3);
  });

  test("keeps prepared execution exceptions distinct and supervises a stable repeat", async () => {
    const failures = [
      codedFailure("permission_denied", "Permission diagnostic."),
      codedFailure("read_timeout", "Timeout diagnostic one."),
      codedFailure("read_timeout", "Timeout diagnostic two."),
    ];
    const fixture = await createFixture("worker", () => {
      throw failures.shift()!;
    });

    await executeObservation(fixture, FIRST_RANGE);
    await executeObservation(fixture, FIRST_RANGE);

    const [permissionExecution, timeoutExecution] =
      fixture.ledger.current().state.capabilityExecutions;
    expect(permissionExecution?.outcomeFingerprint).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
    expect(timeoutExecution?.outcomeFingerprint).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
    expect(timeoutExecution?.outcomeFingerprint).not.toBe(
      permissionExecution?.outcomeFingerprint,
    );
    expect(
      JSON.stringify([permissionExecution, timeoutExecution]),
    ).not.toContain("permission_denied");
    expect(
      JSON.stringify([permissionExecution, timeoutExecution]),
    ).not.toContain("read_timeout");
    expect(
      fixture.ledger.current().state.operationSupervision.entries[0],
    ).toMatchObject({ stage: "tracking", matchingOutcomeCount: 1 });

    await executeObservation(fixture, FIRST_RANGE);

    expect(
      fixture.ledger.current().state.operationSupervision.entries[0],
    ).toMatchObject({
      stage: "warning",
      priorOutcome: "failed",
      matchingOutcomeCount: 2,
      originExecutionId: "capability-execution-3",
    });
    expect(fixture.externalExecute).toHaveBeenCalledTimes(3);

    await expect(
      executeObservation(fixture, FIRST_RANGE),
    ).resolves.toMatchObject({ kind: "operation_supervision_intervened" });
    expect(fixture.externalExecute).toHaveBeenCalledTimes(3);
  });

  test("uses a canonical error name and message when execution has no stable fields", async () => {
    const fixture = await createFixture("worker", () => {
      throw new Error("The adapter transport is unavailable.");
    });

    await executeObservation(fixture, FIRST_RANGE);
    await executeObservation(fixture, FIRST_RANGE);

    expect(
      fixture.ledger.current().state.operationSupervision.entries[0],
    ).toMatchObject({ stage: "warning", matchingOutcomeCount: 2 });
  });

  test("fails open for an unsafe prepared execution exception identity", async () => {
    const fixture = await createFixture("worker", () => {
      throw Object.assign(new Error("Unsafe adapter failure."), {
        code: Symbol("unstable-code"),
      });
    });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(executeObservation(fixture, FIRST_RANGE)).resolves.toEqual({
        executionId: `capability-execution-${attempt + 1}`,
      });
    }

    expect(fixture.externalExecute).toHaveBeenCalledTimes(4);
    expect(fixture.ledger.current().state.operationSupervision.entries).toEqual(
      [],
    );
    expect(
      fixture.ledger
        .current()
        .state.capabilityExecutions.every(
          ({ outcomeFingerprint }) => outcomeFingerprint === null,
        ),
    ).toBe(true);
  });

  test("keeps AbortError from prepared execution raw", async () => {
    const abortError = new Error("Execution aborted.");
    abortError.name = "AbortError";
    const fixture = await createFixture("worker", () => {
      throw abortError;
    });

    await expect(executeObservation(fixture, FIRST_RANGE)).rejects.toBe(
      abortError,
    );
    expect(fixture.externalExecute).toHaveBeenCalledTimes(1);
    expect(fixture.ledger.current().state.operationSupervision.entries).toEqual(
      [],
    );
  });

  test("keeps distinct invalid adapter-result failures separate", async () => {
    const invalidResults = [
      Object.freeze({}),
      Object.freeze({
        outcome: "failed",
        observedEffect: "none",
        summary: "",
        failureOutcomeFingerprint: failureFingerprint("summary_invalid"),
      }),
      Object.freeze({
        outcome: "failed",
        observedEffect: "none",
        summary: "",
        failureOutcomeFingerprint: failureFingerprint("summary_invalid"),
      }),
    ];
    const fixture = await createFixture(
      "worker",
      () => invalidResults.shift() as WorkerCapabilityAdapterResult,
    );

    await executeObservation(fixture, FIRST_RANGE);
    await executeObservation(fixture, FIRST_RANGE);

    const [shapeFailure, summaryFailure] =
      fixture.ledger.current().state.capabilityExecutions;
    expect(shapeFailure?.outcomeFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(summaryFailure?.outcomeFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(summaryFailure?.outcomeFingerprint).not.toBe(
      shapeFailure?.outcomeFingerprint,
    );

    await executeObservation(fixture, FIRST_RANGE);
    expect(
      fixture.ledger.current().state.operationSupervision.entries[0],
    ).toMatchObject({
      stage: "warning",
      priorOutcome: "failed",
      matchingOutcomeCount: 2,
    });
  });

  test("rejects missing and malformed adapter failure identities as distinct stable contract failures", async () => {
    const invalidResults = [
      Object.freeze({
        outcome: "failed",
        observedEffect: "none",
        summary: "The selected read failed.",
      }),
      Object.freeze({
        outcome: "failed",
        observedEffect: "none",
        summary: "The selected read failed.",
        failureOutcomeFingerprint: "not-an-opaque-fingerprint",
      }),
      Object.freeze({
        outcome: "failed",
        observedEffect: "none",
        summary: "The selected read failed.",
        failureOutcomeFingerprint: "not-an-opaque-fingerprint",
      }),
    ];
    const fixture = await createFixture(
      "worker",
      () => invalidResults.shift() as WorkerCapabilityAdapterResult,
    );

    await executeObservation(fixture, FIRST_RANGE);
    await executeObservation(fixture, FIRST_RANGE);

    const [missingFailure, malformedFailure] =
      fixture.ledger.current().state.capabilityExecutions;
    expect(missingFailure?.outcomeFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(malformedFailure?.outcomeFingerprint).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
    expect(malformedFailure?.outcomeFingerprint).not.toBe(
      missingFailure?.outcomeFingerprint,
    );

    await executeObservation(fixture, FIRST_RANGE);
    expect(
      fixture.ledger.current().state.operationSupervision.entries[0],
    ).toMatchObject({
      stage: "warning",
      priorOutcome: "failed",
      matchingOutcomeCount: 2,
    });
  });

  test("supervises repeated adapter preparation failures by stable error identity", async () => {
    let messageSequence = 0;
    const fixture = await createPreparationFailureFixture("worker", () =>
      preparationFailure(
        "payload_author_failed",
        `Transient diagnostic ${++messageSequence}`,
      ),
    );

    await expect(executeObservation(fixture, FIRST_RANGE)).resolves.toEqual({
      executionId: "capability-execution-1",
    });
    await expect(executeObservation(fixture, FIRST_RANGE)).resolves.toEqual({
      executionId: "capability-execution-2",
    });
    expect(fixture.prepare).toHaveBeenCalledTimes(2);
    expect(fixture.externalExecute).not.toHaveBeenCalled();
    expect(fixture.ledger.current().state.operationSupervision.entries).toEqual(
      [
        expect.objectContaining({
          stage: "warning",
          priorOutcome: "failed",
          matchingOutcomeCount: 2,
          originExecutionId: "capability-execution-2",
        }),
      ],
    );

    await expect(
      executeObservation(fixture, FIRST_RANGE),
    ).resolves.toMatchObject({
      kind: "operation_supervision_intervened",
    });
    expect(fixture.prepare).toHaveBeenCalledTimes(3);
    expect(fixture.ledger.current().state.capabilityExecutions).toHaveLength(2);

    await expect(executeObservation(fixture, FIRST_RANGE)).rejects.toThrow(
      "worker_capability_begin_rejected:operation_supervision_limit_exceeded",
    );
    expect(fixture.prepare).toHaveBeenCalledTimes(4);
    expect(fixture.externalExecute).not.toHaveBeenCalled();
    expect(fixture.ledger.current().state.capabilityExecutions).toHaveLength(2);
  });

  test("ignores preparation intent while keeping error codes and controls separate", async () => {
    let errorCode = "payload_author_failed";
    const fixture = await createPreparationFailureFixture("worker", () =>
      preparationFailure(errorCode, "Preparation failed."),
    );

    await executeObservationWithIntent(
      fixture,
      FIRST_RANGE,
      "Author the first exact payload.",
    );
    await executeObservationWithIntent(
      fixture,
      FIRST_RANGE,
      "Presentation-only wording changed.",
    );
    expect(fixture.ledger.current().state.operationSupervision.entries).toEqual(
      [expect.objectContaining({ stage: "warning", matchingOutcomeCount: 2 })],
    );

    errorCode = "payload_contract_invalid";
    await executeObservationWithIntent(
      fixture,
      FIRST_RANGE,
      "Author the first exact payload.",
    );
    errorCode = "payload_author_failed";
    await executeObservationWithIntent(
      fixture,
      SECOND_RANGE,
      "Author the first exact payload.",
    );

    const entries = fixture.ledger.current().state.operationSupervision.entries;
    expect(entries).toHaveLength(3);
    expect(
      new Set(entries.map(({ actionFingerprint }) => actionFingerprint)).size,
    ).toBe(3);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: "warning", matchingOutcomeCount: 2 }),
      ]),
    );
  });

  test("keeps preparation working directories in distinct fallback identities", () => {
    const error = codedFailure("payload_author_failed", "Preparation failed.");
    const common = {
      capabilityId: observationDescriptor.capabilityId,
      controls: FIRST_RANGE,
      error,
    };

    const first = createWorkerCapabilityPreparationFailureFingerprint({
      ...common,
      workingDirectory: "project-a",
    });
    const second = createWorkerCapabilityPreparationFailureFingerprint({
      ...common,
      workingDirectory: "project-b",
    });

    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(second).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(second).not.toBe(first);
  });

  test("keeps AbortError raw and outside operation supervision", async () => {
    const abortError = new Error("Preparation aborted.");
    abortError.name = "AbortError";
    const fixture = await createPreparationFailureFixture(
      "worker",
      () => abortError,
    );

    await expect(executeObservation(fixture, FIRST_RANGE)).rejects.toBe(
      abortError,
    );
    expect(fixture.prepare).toHaveBeenCalledTimes(1);
    expect(fixture.externalExecute).not.toHaveBeenCalled();
    expect(fixture.ledger.current().state.capabilityExecutions).toEqual([]);
    expect(fixture.ledger.current().state.operationSupervision.entries).toEqual(
      [],
    );
  });

  test("fails open when a preparation failure has no stable identity", async () => {
    const fixture = await createPreparationFailureFixture("worker", () =>
      Symbol("unrepresentable-preparation-failure"),
    );

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(executeObservation(fixture, FIRST_RANGE)).resolves.toEqual({
        executionId: `capability-execution-${attempt + 1}`,
      });
    }

    expect(fixture.prepare).toHaveBeenCalledTimes(4);
    expect(fixture.externalExecute).not.toHaveBeenCalled();
    expect(fixture.ledger.current().state.capabilityExecutions).toHaveLength(4);
    expect(fixture.ledger.current().state.operationSupervision.entries).toEqual(
      [],
    );
  });

  test("coalesces exact batch duplicates that fail during preparation", async () => {
    const fixture = await createPreparationFailureFixture("worker", () =>
      preparationFailure("payload_author_failed", "Preparation failed."),
    );
    const first = invocation(FIRST_RANGE, "First presentation wording.");
    const second = invocation(FIRST_RANGE, "Different presentation wording.");

    await expect(
      createBinding(fixture).executeBatch({
        invocations: [first, second],
      }),
    ).resolves.toEqual({ executionIds: ["capability-execution-1"] });

    expect(fixture.prepare).toHaveBeenCalledTimes(2);
    expect(fixture.externalExecute).not.toHaveBeenCalled();
    expect(fixture.ledger.current().state.capabilityExecutions).toHaveLength(1);
  });

  test.each([
    ["missing", undefined],
    ["malformed", "not-an-action-fingerprint"],
  ] as const)(
    "converts a %s prepared action identity into a stable contract failure without executing its closure",
    async (_caseName, actionFingerprint) => {
      const requestId = `operation-supervision-prepared-contract-${_caseName}`;
      const ledger = await createLedger("worker", requestId);
      const preparedExecute = vi.fn(async () => succeededResult());
      const directExecute = vi.fn(async () => succeededResult());
      const prepare = vi.fn(async () =>
        Object.freeze({
          ...(actionFingerprint === undefined ? {} : { actionFingerprint }),
          acceptedControls: FIRST_RANGE,
          execute: preparedExecute,
        }),
      );
      const adapter: WorkerCapabilityAdapter<TestContext> = Object.freeze({
        descriptor: observationDescriptor,
        prepare,
        execute: directExecute,
      });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const binding = createRoleCapabilityBinding({
          requestId,
          context: Object.freeze({ owner: "worker" as const }),
          call: requireActiveCall(ledger),
          ledger,
          adapters: [adapter],
        });
        await binding.execute(
          invocation(FIRST_RANGE, `Prepared contract attempt ${attempt + 1}.`),
        );
      }

      expect(prepare).toHaveBeenCalledTimes(2);
      expect(preparedExecute).not.toHaveBeenCalled();
      expect(directExecute).not.toHaveBeenCalled();
      expect(ledger.current().state.operationSupervision.entries).toEqual([
        expect.objectContaining({
          stage: "warning",
          priorOutcome: "failed",
          matchingOutcomeCount: 2,
        }),
      ]);
    },
  );

  test("stores a valid adapter-provided exact identity unchanged", async () => {
    const fixture = await createFixture("worker");

    await executeObservation(fixture, FIRST_RANGE);

    expect(
      fixture.ledger.current().state.capabilityExecutions[0]?.actionFingerprint,
    ).toBe(fingerprint(FIRST_RANGE));
  });

  test("coalesces exact batch duplicates but executes different ranges", async () => {
    const fixture = await createFixture("worker");

    const duplicateBatch = createBinding(fixture).executeBatch({
      invocations: [
        invocation(FIRST_RANGE, "Read the first copy."),
        invocation(FIRST_RANGE, "Read the duplicate copy."),
      ],
    });
    await expect(duplicateBatch).resolves.toEqual({
      executionIds: ["capability-execution-1"],
    });
    expect(fixture.prepare).toHaveBeenCalledTimes(2);
    expect(fixture.externalExecute).toHaveBeenCalledTimes(1);
    expect(fixture.ledger.current().state.capabilityExecutions).toHaveLength(1);

    const distinctBatch = createBinding(fixture).executeBatch({
      invocations: [
        invocation(FIRST_RANGE, "Read the first range again."),
        invocation(SECOND_RANGE, "Read a different range."),
      ],
    });
    await expect(distinctBatch).resolves.toEqual({
      executionIds: ["capability-execution-2", "capability-execution-3"],
    });
    expect(fixture.externalExecute).toHaveBeenCalledTimes(3);
    expect(fixture.ledger.current().state.capabilityExecutions).toHaveLength(3);
  });

  test("commits adapter-materialized controls for distinct batch actions", async () => {
    const requestId = "operation-supervision-materialized-batch-controls";
    const ledger = await createLedger("root", requestId);
    const materializedDescriptor: WorkerCapabilityDescriptor = Object.freeze({
      ...observationDescriptor,
      controls: Object.freeze({
        type: "object" as const,
        additionalProperties: false as const,
        properties: Object.freeze({
          path: observationDescriptor.controls.properties.path!,
        }),
        required: Object.freeze(["path"]),
      }),
    });
    const materializedRanges = [FIRST_RANGE, SECOND_RANGE] as const;
    let preparationIndex = 0;
    const adapter: WorkerCapabilityAdapter<TestContext> = Object.freeze({
      descriptor: materializedDescriptor,
      prepare: vi.fn(async () => {
        const acceptedControls = materializedRanges[preparationIndex++];
        if (!acceptedControls) {
          throw new Error("unexpected materialized batch preparation");
        }
        return Object.freeze({
          acceptedControls,
          actionFingerprint: fingerprint(acceptedControls),
          execute: async () => succeededResult(),
        });
      }),
      execute: async () => {
        throw new Error("prepared adapter execution was bypassed");
      },
    });
    const selectionControls = Object.freeze({ path: FIRST_RANGE.path });
    const binding = createRoleCapabilityBinding({
      requestId,
      context: Object.freeze({ owner: "root" as const }),
      call: requireActiveCall(ledger),
      ledger,
      adapters: [adapter],
    });

    await expect(
      binding.executeBatch({
        invocations: [
          invocation(selectionControls, "Read the first materialized range."),
          invocation(selectionControls, "Read the second materialized range."),
        ],
      }),
    ).resolves.toEqual({
      executionIds: ["capability-execution-1", "capability-execution-2"],
    });

    expect(
      ledger.current().state.capabilityExecutions.map(({ controlsJson }) =>
        JSON.parse(controlsJson),
      ),
    ).toEqual(materializedRanges);
  });

  test("does not track stale root batch actions at final admission", async () => {
    const fixture = await createFixture("root");
    const isCurrent = vi.fn(() => false);
    const binding = createRoleCapabilityBinding({
      requestId: fixture.requestId,
      context: Object.freeze({ owner: fixture.owner }),
      call: requireActiveCall(fixture.ledger),
      ledger: fixture.ledger,
      adapters: [fixture.adapter],
      executionFreshness: Object.freeze({
        token: Object.freeze({
          kind: "request_steering_v1" as const,
          version: 0,
          updates: Object.freeze([]),
        }),
        isCurrent,
      }),
    });

    await expect(
      binding.executeBatch({
        invocations: [
          invocation(FIRST_RANGE, "Read the first range."),
          invocation(SECOND_RANGE, "Read the second range."),
        ],
      }),
    ).resolves.toEqual({
      executionIds: ["capability-execution-1", "capability-execution-2"],
    });

    expect(isCurrent).toHaveBeenCalledTimes(1);
    expect(fixture.externalExecute).toHaveBeenCalledTimes(2);
    expect(
      fixture.ledger
        .current()
        .state.capabilityExecutions.map(
          ({ actionFingerprint }) => actionFingerprint,
        ),
    ).toEqual([undefined, undefined]);
    expect(fixture.ledger.current().state.operationSupervision.entries).toEqual(
      [],
    );
  });

  test("keeps equal opaque fingerprints independent across capabilities", async () => {
    const requestId = "operation-supervision-capability-identity";
    const ledger = await createLedger("worker", requestId);
    const sharedFingerprint = fingerprint(FIRST_RANGE);
    const firstExecute = vi.fn(async () => succeededResult());
    const secondExecute = vi.fn(async () => succeededResult());
    const createAdapter = (
      descriptor: WorkerCapabilityDescriptor,
      execute: typeof firstExecute,
    ): WorkerCapabilityAdapter<TestContext> =>
      Object.freeze({
        descriptor,
        prepare: async () =>
          Object.freeze({
            actionFingerprint: sharedFingerprint,
            acceptedControls: FIRST_RANGE,
            execute,
          }),
        execute: async () => {
          throw new Error("prepared adapter execution was bypassed");
        },
      });
    const adapters = [
      createAdapter(observationDescriptor, firstExecute),
      createAdapter(alternateObservationDescriptor, secondExecute),
    ];
    const call = requireActiveCall(ledger);
    const binding = createRoleCapabilityBinding({
      requestId,
      context: Object.freeze({ owner: "worker" as const }),
      call,
      ledger,
      adapters,
    });

    await expect(
      binding.executeBatch({
        invocations: adapters.map(({ descriptor }) => ({
          capabilityId: descriptor.capabilityId,
          intent: `Use ${descriptor.capabilityId}.`,
          controls: FIRST_RANGE,
        })),
      }),
    ).resolves.toEqual({
      executionIds: ["capability-execution-1", "capability-execution-2"],
    });

    expect(firstExecute).toHaveBeenCalledTimes(1);
    expect(secondExecute).toHaveBeenCalledTimes(1);
    expect(ledger.current().state.operationSupervision.entries).toEqual([
      expect.objectContaining({
        capabilityId: observationDescriptor.capabilityId,
        actionFingerprint: sharedFingerprint,
        stage: "tracking",
      }),
      expect.objectContaining({
        capabilityId: alternateObservationDescriptor.capabilityId,
        actionFingerprint: sharedFingerprint,
        stage: "tracking",
      }),
    ]);
  });

  test("supervises direct adapters by canonical controls while keeping different controls distinct", async () => {
    const requestId = "operation-supervision-legacy";
    const ledger = await createLedger("worker", requestId);
    const execute = vi.fn<WorkerCapabilityAdapter<TestContext>["execute"]>(
      async () => succeededResult(),
    );
    const adapter: WorkerCapabilityAdapter<TestContext> = Object.freeze({
      descriptor: observationDescriptor,
      execute,
    });

    for (const [controls, intent] of [
      [FIRST_RANGE, "First direct read."],
      [SECOND_RANGE, "Different direct read."],
      [FIRST_RANGE, "Repeated direct read."],
    ] as const) {
      const call = requireActiveCall(ledger);
      const binding = createRoleCapabilityBinding({
        requestId,
        context: Object.freeze({ owner: "worker" as const }),
        call,
        ledger,
        adapters: [adapter],
      });
      await binding.execute(invocation(controls, intent));
    }

    expect(execute).toHaveBeenCalledTimes(3);
    expect(ledger.current().state.operationSupervision.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: "warning", matchingOutcomeCount: 2 }),
        expect.objectContaining({ stage: "tracking", matchingOutcomeCount: 1 }),
      ]),
    );

    const binding = createRoleCapabilityBinding({
      requestId,
      context: Object.freeze({ owner: "worker" as const }),
      call: requireActiveCall(ledger),
      ledger,
      adapters: [adapter],
    });
    await expect(
      binding.execute(invocation(FIRST_RANGE, "Intervene direct repeat.")),
    ).resolves.toMatchObject({ kind: "operation_supervision_intervened" });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  test("coalesces exact direct-adapter batch duplicates and executes different controls", async () => {
    const requestId = "operation-supervision-legacy-batch";
    const ledger = await createLedger("worker", requestId);
    const execute = vi.fn<WorkerCapabilityAdapter<TestContext>["execute"]>(
      async () => succeededResult(),
    );
    const adapter: WorkerCapabilityAdapter<TestContext> = Object.freeze({
      descriptor: observationDescriptor,
      execute,
    });
    const createDirectBinding = () =>
      createRoleCapabilityBinding({
        requestId,
        context: Object.freeze({ owner: "worker" as const }),
        call: requireActiveCall(ledger),
        ledger,
        adapters: [adapter],
      });

    await expect(
      createDirectBinding().executeBatch({
        invocations: [
          invocation(FIRST_RANGE, "First direct batch read."),
          invocation(FIRST_RANGE, "Duplicate direct batch read."),
        ],
      }),
    ).resolves.toEqual({ executionIds: ["capability-execution-1"] });
    expect(execute).toHaveBeenCalledTimes(1);

    await expect(
      createDirectBinding().executeBatch({
        invocations: [
          invocation(FIRST_RANGE, "Repeated direct batch read."),
          invocation(SECOND_RANGE, "Different direct batch read."),
        ],
      }),
    ).resolves.toEqual({
      executionIds: ["capability-execution-2", "capability-execution-3"],
    });
    expect(execute).toHaveBeenCalledTimes(3);
  });
});

type Fixture = Readonly<{
  owner: Owner;
  requestId: string;
  ledger: RoleCallLedger;
  adapter: WorkerCapabilityAdapter<TestContext>;
  prepare: ReturnType<typeof vi.fn>;
  externalExecute: ReturnType<typeof vi.fn>;
}>;

async function createFixture(
  owner: Owner,
  nextResult: () => WorkerCapabilityAdapterResult = succeededResult,
): Promise<Fixture> {
  const requestId = `operation-supervision-${owner}`;
  const ledger = await createLedger(owner, requestId);
  const externalExecute = vi.fn(
    async (_controls: WorkerCapabilityControls, _executionId: string) =>
      nextResult(),
  );
  const prepare = vi.fn<
    NonNullable<WorkerCapabilityAdapter<TestContext>["prepare"]>
  >(async ({ controls }) =>
    Object.freeze({
      actionFingerprint: fingerprint(controls),
      acceptedControls: controls,
      execute: async (executionId: string) =>
        externalExecute(controls, executionId),
    }),
  );
  const adapter: WorkerCapabilityAdapter<TestContext> = Object.freeze({
    descriptor: observationDescriptor,
    prepare,
    execute: async () => {
      throw new Error("prepared adapter execution was bypassed");
    },
  });
  return Object.freeze({
    owner,
    requestId,
    ledger,
    adapter,
    prepare,
    externalExecute,
  });
}

async function createPreparationFailureFixture(
  owner: Owner,
  nextError: () => unknown,
): Promise<Fixture> {
  const requestId = `operation-supervision-prepare-failure-${owner}`;
  const ledger = await createLedger(owner, requestId);
  const externalExecute = vi.fn(async () => succeededResult());
  const prepare = vi.fn<
    NonNullable<WorkerCapabilityAdapter<TestContext>["prepare"]>
  >(async () => {
    throw nextError();
  });
  const adapter: WorkerCapabilityAdapter<TestContext> = Object.freeze({
    descriptor: observationDescriptor,
    prepare,
    execute: externalExecute,
  });
  return Object.freeze({
    owner,
    requestId,
    ledger,
    adapter,
    prepare,
    externalExecute,
  });
}

async function createLedger(owner: Owner, requestId: string) {
  const ledger = createRoleCallLedger({
    requestId,
    policy: {
      authority: authorityFor(owner),
      limits: {
        maxDepth: 4,
        maxCalls: 8,
        maxCapabilityExecutions: 16,
        maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
        maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
        maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
      },
    },
  });
  await commit(ledger, { authority: "runtime", type: "create_root" });
  if (owner === "worker") {
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Read exact bounded ranges.",
      workerCapabilityScope: { catalogGroupIds: ["files"] },
    });
  }
  return ledger;
}

function createBinding(fixture: Fixture) {
  return createRoleCapabilityBinding({
    requestId: fixture.requestId,
    context: Object.freeze({ owner: fixture.owner }),
    call: requireActiveCall(fixture.ledger),
    ledger: fixture.ledger,
    adapters: [fixture.adapter],
  });
}

function executeObservation(
  fixture: Fixture,
  controls: WorkerCapabilityControls,
) {
  return executeObservationWithIntent(
    fixture,
    controls,
    "Read the exact selected range.",
  );
}

function executeObservationWithIntent(
  fixture: Fixture,
  controls: WorkerCapabilityControls,
  intent: string,
) {
  return createBinding(fixture).execute(invocation(controls, intent));
}

function invocation(controls: WorkerCapabilityControls, intent: string) {
  return Object.freeze({
    capabilityId: observationDescriptor.capabilityId,
    intent,
    controls,
  });
}

function succeededResult(): WorkerCapabilityAdapterResult {
  return Object.freeze({
    outcome: "succeeded" as const,
    observedEffect: "observation" as const,
    summary: "Read the selected range.",
  });
}

function failedResult(errorCode: string): WorkerCapabilityAdapterResult {
  return Object.freeze({
    outcome: "failed" as const,
    observedEffect: "none" as const,
    summary: "The selected read failed.",
    failureOutcomeFingerprint: failureFingerprint(errorCode),
    exactResult: Object.freeze({
      kind: "registered_tool_execution_result_v1" as const,
      authority: "registered_plugin" as const,
      status: "executed" as const,
      result: Object.freeze({
        ok: false,
        tool: "inspect_target",
        output: "Read failed.",
        producedNewInformation: false,
        error: "Read failed.",
        errorCode,
      }),
    }),
  });
}

function failureFingerprint(identity: string): string {
  return `sha256:${createHash("sha256").update(identity).digest("hex")}`;
}

function preparationFailure(code: string, message: string): Error {
  return codedFailure(code, message);
}

function codedFailure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function fingerprint(controls: WorkerCapabilityControls): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(controls))
    .digest("hex")}`;
}

function authorityFor(owner: Owner): ExecutionPolicyAuthoritySnapshot {
  if (owner === "worker") return SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT;
  return Object.freeze({
    id: "execution-agent-v1",
    version: 1,
    definitionHash: `sha256:${"d".repeat(64)}`,
    rootContractId: "execution_agent",
    availableSubordinateContractIds: Object.freeze(["worker"] as const),
    capabilityAuthorities: Object.freeze(["root", "worker"] as const),
  });
}

function requireActiveCall(ledger: RoleCallLedger): RoleCallFrame {
  const head = ledger.current();
  const call = head.state.calls.find(
    (candidate) => candidate.callId === head.state.activeCallId,
  );
  if (!call) throw new Error("active call missing");
  return call;
}

async function commit(ledger: RoleCallLedger, command: unknown): Promise<void> {
  const result = await ledger.apply({
    expectedHead: ledger.current(),
    command,
  });
  if (!result.ok) throw new Error(result.code);
}
