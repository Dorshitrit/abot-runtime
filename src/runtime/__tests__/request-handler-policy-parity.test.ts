import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type WebSocket from "ws";

import type { SessionRecord } from "../../sessions/types.js";
import { REQUEST_INVOKED_STEP_IDS } from "../config/runner/contracts.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type { EventSink, EventSinkFactory, RuntimeConfig } from "../ports.js";
import type {
  RequestHandlerOptions,
  RunRequestMessage,
} from "../request/contracts.js";
import {
  isRequestExecutionScope,
  type RequestExecutionScope,
} from "../request/execution-scope.js";
import { handleRunRequest } from "../request/handler.js";
import { runRequestRunner } from "../request/runner.js";
import {
  EXECUTION_AGENT_V1_EXECUTION_POLICY,
  SUPERVISOR_WORKER_V1_EXECUTION_POLICY,
} from "../request/role-executor-composition.js";
import type { RequestSessionStore } from "../request/session-store.js";

vi.mock("../request/runner.js", () => ({
  runRequestRunner: vi.fn(),
}));

type PolicyFixture = Readonly<{
  requestId: string;
  sessionId: string;
  profileId: string;
  policyId: "supervisor-worker-v1" | "execution-agent-v1";
  prompt: string;
  rawOutput: string;
  finalOutput: string;
}>;

type TimelineEntry = Readonly<{
  requestId: string;
  operation: string;
  detail?: string;
}>;

type PersistedEvent = Readonly<{
  sessionId: string;
  requestId: string;
  payload: Record<string, unknown>;
}>;

const fixtures: readonly PolicyFixture[] = Object.freeze([
  Object.freeze({
    requestId: "request-delegated",
    sessionId: "session-delegated",
    profileId: "delegated-profile",
    policyId: "supervisor-worker-v1",
    prompt: "Complete the delegated request.",
    rawOutput: "  delegated answer  ",
    finalOutput: "delegated answer",
  }),
  Object.freeze({
    requestId: "request-direct",
    sessionId: "session-direct",
    profileId: "direct-profile",
    policyId: "execution-agent-v1",
    prompt: "Complete the direct request.",
    rawOutput: "  direct answer\n",
    finalOutput: "  direct answer\n",
  }),
]);

const temporaryRoots: string[] = [];

beforeEach(() => {
  configureDebugLogger({ enabled: false });
});

afterEach(async () => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("request handler policy parity", () => {
  test("preserves request-scoped policy, session, event, and finalization ordering while both policies overlap", async () => {
    const timeline: TimelineEntry[] = [];
    const persistedEvents: PersistedEvent[] = [];
    const sessions = new Map<string, SessionRecord>();
    const sessionStore = createSessionStore({
      timeline,
      persistedEvents,
      sessions,
    });
    const eventSinkFactory = createRecordingEventSinkFactory(timeline);
    const runtimeConfig = await createRuntimeConfig();
    const options: RequestHandlerOptions = {
      runtimeConfig,
      sessionStore,
      eventSinkFactory,
      modelGatewayClient: {
        invoke: vi.fn(async () => {
          throw new Error("model gateway must stay behind the mocked runner");
        }),
        invokeRaw: vi.fn(async () => {
          throw new Error("model gateway must stay behind the mocked runner");
        }),
      },
    };
    const capturedRequests = new Map<string, RequestExecutionScope>();
    const capturedPolicies = new Map<string, string>();
    const bothRunnersEntered = createDeferred<void>();
    const releaseRunners = createDeferred<void>();
    let enteredCount = 0;

    vi.mocked(runRequestRunner).mockImplementation(
      async (request, runnerOptions) => {
        if (!isRequestExecutionScope(request)) {
          throw new Error("production handler must compose request scope");
        }
        const fixture = fixtureForRequest(request.requestId);
        capturedRequests.set(request.requestId, request);
        capturedPolicies.set(
          request.requestId,
          request.executionPolicy.authority.id,
        );
        expect(runnerOptions).not.toHaveProperty("executionPolicy");
        record(timeline, request.requestId, "runner.enter");
        enteredCount += 1;
        if (enteredCount === fixtures.length) {
          bothRunnersEntered.resolve();
        }

        await releaseRunners.promise;

        request.onAcknowledgement(`ack:${request.requestId}`);
        request.onThinkingDelta(`thought:${request.requestId}`);
        request.onThinkingTrace({
          step: `step:${request.requestId}`,
          status: "completed",
          text: `trace:${request.requestId}`,
        });
        await request.onSessionTitle(`title:${request.requestId}`);
        request.onAnswerToken(fixture.rawOutput);
        record(timeline, request.requestId, "runner.return");

        return {
          output: fixture.rawOutput,
          ...(fixture.policyId === "execution-agent-v1"
            ? { outputTextMode: "exact" as const }
            : {}),
          finalObservation: {
            observationMeta: {
              kind: "task_result" as const,
              carryPolicy: "always" as const,
              taskResultRole: "supplemental_follow_up" as const,
            },
            observationContent: `observation:${request.requestId}`,
          },
        };
      },
    );

    const pendingRequests = fixtures.map((fixture) =>
      handleRunRequest(
        {} as WebSocket,
        createRunRequestMessage(fixture),
        options,
      ),
    );

    await bothRunnersEntered.promise;
    releaseRunners.resolve();

    const delegated = capturedRequests.get("request-delegated");
    const direct = capturedRequests.get("request-direct");
    expect(delegated).toBeDefined();
    expect(direct).toBeDefined();
    expect(capturedPolicies).toEqual(
      new Map([
        ["request-delegated", "supervisor-worker-v1"],
        ["request-direct", "execution-agent-v1"],
      ]),
    );
    expect(delegated?.executionPolicy).toBe(
      SUPERVISOR_WORKER_V1_EXECUTION_POLICY,
    );
    expect(direct?.executionPolicy).toBe(EXECUTION_AGENT_V1_EXECUTION_POLICY);
    expect(delegated?.executionPolicySelection).toEqual({
      policy: "supervisor-worker-v1",
      primaryProfileId: "delegated-profile",
      source: "model_profile",
    });
    expect(direct?.executionPolicySelection).toEqual({
      policy: "execution-agent-v1",
      primaryProfileId: "direct-profile",
      source: "model_profile",
    });
    expect(delegated?.prompt).toBe("Complete the delegated request.");
    expect(direct?.prompt).toBe("Complete the direct request.");
    expect(delegated?.modelPreference).toEqual({
      profileId: "delegated-profile",
      scope: "all",
    });
    expect(direct?.modelPreference).toEqual({
      profileId: "direct-profile",
      scope: "all",
    });
    expect(delegated?.historyMessages).toEqual([]);
    expect(direct?.historyMessages).toEqual([]);
    expect(delegated?.abortSignal).not.toBe(direct?.abortSignal);
    expect(delegated?.temporalContext).not.toBe(direct?.temporalContext);
    expect(delegated?.contextCompactionStore).not.toBe(
      direct?.contextCompactionStore,
    );
    expect(delegated?.requestSteering).not.toBe(direct?.requestSteering);
    expect(delegated?.workerCapabilities.provider).not.toBe(
      direct?.workerCapabilities.provider,
    );
    expect(Object.hasOwn(delegated!, "workerCapabilityProvider")).toBe(false);
    expect(Object.hasOwn(direct!, "workerCapabilityProvider")).toBe(false);

    await Promise.all(pendingRequests);

    for (const fixture of fixtures) {
      expectRequestTimeline(timeline, fixture.requestId);
      expectFinalizedSession(sessions, fixture);
      expectPersistedEvents(persistedEvents, fixture);
    }
  });
});

function createRunRequestMessage(fixture: PolicyFixture): RunRequestMessage {
  return {
    type: "run_request",
    requestId: fixture.requestId,
    sessionId: fixture.sessionId,
    input: fixture.prompt,
    agentMode: "reasoning",
    modelPreference: {
      profileId: fixture.profileId,
      scope: "all",
    },
    toolPermissionMode: "ask",
  };
}

async function createRuntimeConfig(): Promise<RuntimeConfig> {
  const rootDir = await mkdtemp(join(tmpdir(), "runtime-handler-parity-"));
  temporaryRoots.push(rootDir);
  const configPath = join(rootDir, "request-runner.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      models: {
        defaults: {
          profileId: "delegated-profile",
          steps: Object.fromEntries(
            REQUEST_INVOKED_STEP_IDS.map((stepId) => [stepId, stepId]),
          ),
        },
      },
      context: {
        outputReserveTokens: 4_096,
        safetyReserveTokens: 1_200,
        attachmentReserveTokens: 1_024,
      },
      steps: Object.fromEntries(
        REQUEST_INVOKED_STEP_IDS.map((stepId) => [
          stepId,
          { timeoutMs: 20_000 },
        ]),
      ),
    }),
  );

  return {
    runtimeId: "request-handler-parity",
    agentBridgeUrl: "ws://test",
    modelGatewayUrl: "http://model",
    paths: {
      rootDir,
      runtimeDir: join(rootDir, ".runtime"),
      agentWorkDir: join(rootDir, "agent-work"),
      sessionsDir: join(rootDir, "sessions"),
      attachmentsDir: join(rootDir, "attachments"),
      workspaceDir: join(rootDir, "workspace"),
      sharedDir: join(rootDir, "shared"),
      compiledDir: join(rootDir, "compiled"),
      traceFile: join(rootDir, "runtime-debug.jsonl"),
    },
    models: {
      providers: { local: { type: "ollama" } },
      profiles: {
        "delegated-profile": {
          provider: "local",
          model: "delegated:test",
          contextWindowTokens: 24_000,
        },
        "direct-profile": {
          provider: "local",
          model: "direct:test",
          contextWindowTokens: 24_000,
        },
      },
    },
    modelExecutionPolicies: {
      "delegated-profile": { policy: "supervisor-worker-v1" },
      "direct-profile": { policy: "execution-agent-v1" },
    },
    requestRunner: { configPath },
  };
}

function createSessionStore(params: {
  timeline: TimelineEntry[];
  persistedEvents: PersistedEvent[];
  sessions: Map<string, SessionRecord>;
}): RequestSessionStore {
  const getSession = (sessionId: string): SessionRecord => {
    const existing = params.sessions.get(sessionId);
    if (existing) {
      return existing;
    }
    const now = "2026-08-18T00:00:00.000Z";
    const created: SessionRecord = {
      id: sessionId,
      title: sessionId,
      createdAt: now,
      updatedAt: now,
      lastAgentMode: "reasoning",
      messageCount: 0,
      messages: [],
    };
    params.sessions.set(sessionId, created);
    return created;
  };

  return {
    compareAndSwapSessionMemoryCheckpoint: async (_sessionId, command) => ({
      committed: true,
      checkpoint: command.checkpoint,
    }),
    getOrCreateSession: async (sessionId) => {
      record(params.timeline, requestIdForSession(sessionId), "session.open");
      return getSession(sessionId);
    },
    startRequestStream: async (sessionId, requestId) => {
      record(params.timeline, requestId, "session.stream.start");
      return getSession(sessionId);
    },
    appendMessage: async (sessionId, role, content, options) => {
      const requestId = options?.requestId ?? requestIdForSession(sessionId);
      record(params.timeline, requestId, `session.message.${role}`, content);
      const current = getSession(sessionId);
      const next: SessionRecord = {
        ...current,
        title: current.title,
        updatedAt: "2026-08-18T00:00:01.000Z",
        lastAgentMode: options?.lastAgentMode ?? current.lastAgentMode,
        messageCount: current.messageCount + 1,
        messages: [
          ...current.messages,
          {
            id: `${sessionId}:message:${String(current.messageCount + 1)}`,
            role,
            content,
            createdAt: "2026-08-18T00:00:01.000Z",
            ...(options?.requestId ? { requestId: options.requestId } : {}),
            ...(options?.grounding ? { grounding: options.grounding } : {}),
            ...(options?.observationMeta
              ? { observationMeta: options.observationMeta }
              : {}),
            ...(options?.observationContent
              ? { observationContent: options.observationContent }
              : {}),
            ...(options?.thinkingTrace
              ? { thinkingTrace: options.thinkingTrace }
              : {}),
          },
        ],
      };
      params.sessions.set(sessionId, next);
      return next;
    },
    appendRequestEvent: async (sessionId, requestId, payload) => {
      record(params.timeline, requestId, "session.event.persist");
      params.persistedEvents.push({ sessionId, requestId, payload });
      return getSession(sessionId);
    },
    updateSessionTitle: async (sessionId, title) => {
      const requestId = requestIdForSession(sessionId);
      record(params.timeline, requestId, "session.title.update", title);
      const current = getSession(sessionId);
      const next = { ...current, title };
      params.sessions.set(sessionId, next);
      return next;
    },
  };
}

function createRecordingEventSinkFactory(
  timeline: TimelineEntry[],
): EventSinkFactory {
  return {
    create: (options) => {
      const lane = options.persist ? "persistent" : "initial";
      record(timeline, options.requestId, `events.create.${lane}`);
      let persistQueue = Promise.resolve();
      let sequence = 0;

      const publish = (payload: Record<string, unknown>): void => {
        sequence += 1;
        if (options.persist) {
          const persistedPayload = {
            ...payload,
            requestId: options.requestId,
            eventSequence: sequence,
          };
          persistQueue = persistQueue.then(async () => {
            await options.persist?.(persistedPayload);
          });
        }
      };

      const event = (
        name: string,
        extra: Record<string, unknown> = {},
      ): void => {
        record(timeline, options.requestId, `events.event.${name}`);
        if (name !== "thinking.started" && name !== "thinking.completed") {
          publish({ type: "event", name, ...extra });
        }
      };

      const sink: EventSink = {
        publish,
        event,
        runtimeState: (state) => {
          record(
            timeline,
            options.requestId,
            `events.state.${state.stage ?? "unknown"}`,
          );
        },
        token: (token) => event("token", { text: token }),
        legacyToken: (text) => {
          record(timeline, options.requestId, "events.answer", text);
          publish({ type: "token", text });
        },
        thinkingDelta: (delta, accumulatedText) => {
          record(timeline, options.requestId, "events.thinking", delta);
          event("thinking.delta", { delta, text: accumulatedText });
        },
        completed: (output) => {
          record(timeline, options.requestId, "events.completed", output);
          publish({ type: "completed", output });
        },
        failed: (error, details) => {
          record(timeline, options.requestId, "events.failed", error);
          publish({ type: "failed", error, ...(details ? { details } : {}) });
        },
        drain: async () => {
          record(timeline, options.requestId, "events.drain.start");
          await persistQueue;
          record(timeline, options.requestId, "events.drain.end");
        },
        dispose: () => {
          record(timeline, options.requestId, `events.dispose.${lane}`);
        },
      };
      return sink;
    },
  };
}

function expectRequestTimeline(
  timeline: readonly TimelineEntry[],
  requestId: string,
): void {
  const operations = timeline
    .filter((entry) => entry.requestId === requestId)
    .map((entry) => entry.operation);
  expectOrderedSubsequence(operations, [
    "events.create.initial",
    "session.open",
    "session.stream.start",
    "events.dispose.initial",
    "events.create.persistent",
    "events.event.thinking.started",
    "session.message.user",
    "events.state.model",
    "runner.enter",
    "events.thinking",
    "events.event.thinking.delta",
    "events.thinking",
    "events.event.thinking.delta",
    "session.title.update",
    "events.event.session.title.updated",
    "events.answer",
    "runner.return",
    "events.state.finalization",
    "session.message.assistant",
    "events.event.thinking.completed",
    "events.completed",
    "events.drain.start",
    "events.drain.end",
    "events.dispose.persistent",
  ]);
  expect(operations).not.toContain("events.failed");
}

function expectFinalizedSession(
  sessions: ReadonlyMap<string, SessionRecord>,
  fixture: PolicyFixture,
): void {
  const session = sessions.get(fixture.sessionId);
  expect(session).toBeDefined();
  expect(session?.title).toBe(`title:${fixture.requestId}`);
  expect(session?.messages).toHaveLength(2);
  expect(session?.messages[0]).toMatchObject({
    role: "user",
    content: fixture.prompt,
    requestId: fixture.requestId,
  });
  expect(session?.messages[1]).toMatchObject({
    role: "assistant",
    content: fixture.finalOutput,
    requestId: fixture.requestId,
    grounding: "conversation",
    observationMeta: {
      kind: "task_result",
      carryPolicy: "always",
      taskResultRole: "supplemental_follow_up",
    },
    observationContent: `observation:${fixture.requestId}`,
    thinkingTrace: [
      {
        sequence: 1,
        step: `step:${fixture.requestId}`,
        status: "completed",
        text: `trace:${fixture.requestId}`,
      },
    ],
  });
}

function expectPersistedEvents(
  events: readonly PersistedEvent[],
  fixture: PolicyFixture,
): void {
  const requestEvents = events.filter(
    ({ requestId }) => requestId === fixture.requestId,
  );
  expect(requestEvents).toHaveLength(5);
  expect(
    requestEvents.map(({ sessionId, requestId, payload }) => ({
      sessionId,
      requestId,
      payloadRequestId: payload.requestId,
      type: payload.type,
      name: payload.name,
    })),
  ).toEqual([
    {
      sessionId: fixture.sessionId,
      requestId: fixture.requestId,
      payloadRequestId: fixture.requestId,
      type: "event",
      name: "thinking.delta",
    },
    {
      sessionId: fixture.sessionId,
      requestId: fixture.requestId,
      payloadRequestId: fixture.requestId,
      type: "event",
      name: "thinking.delta",
    },
    {
      sessionId: fixture.sessionId,
      requestId: fixture.requestId,
      payloadRequestId: fixture.requestId,
      type: "event",
      name: "session.title.updated",
    },
    {
      sessionId: fixture.sessionId,
      requestId: fixture.requestId,
      payloadRequestId: fixture.requestId,
      type: "token",
      name: undefined,
    },
    {
      sessionId: fixture.sessionId,
      requestId: fixture.requestId,
      payloadRequestId: fixture.requestId,
      type: "completed",
      name: undefined,
    },
  ]);
  expect(requestEvents.at(-1)?.payload).toMatchObject({
    output: fixture.finalOutput,
  });
  const serialized = JSON.stringify(requestEvents);
  for (const other of fixtures.filter(
    ({ requestId }) => requestId !== fixture.requestId,
  )) {
    expect(serialized).not.toContain(other.requestId);
    expect(serialized).not.toContain(other.finalOutput);
  }
}

function expectOrderedSubsequence(
  actual: readonly string[],
  expected: readonly string[],
): void {
  let cursor = -1;
  for (const operation of expected) {
    const next = actual.indexOf(operation, cursor + 1);
    expect(
      next,
      `Expected ${operation} after index ${String(cursor)} in ${actual.join(
        " -> ",
      )}`,
    ).toBeGreaterThan(cursor);
    cursor = next;
  }
}

function fixtureForRequest(requestId: string): PolicyFixture {
  const fixture = fixtures.find(
    (candidate) => candidate.requestId === requestId,
  );
  if (!fixture) {
    throw new Error(`unknown request fixture: ${requestId}`);
  }
  return fixture;
}

function requestIdForSession(sessionId: string): string {
  const fixture = fixtures.find(
    (candidate) => candidate.sessionId === sessionId,
  );
  if (!fixture) {
    throw new Error(`unknown session fixture: ${sessionId}`);
  }
  return fixture.requestId;
}

function record(
  timeline: TimelineEntry[],
  requestId: string,
  operation: string,
  detail?: string,
): void {
  timeline.push({ requestId, operation, ...(detail ? { detail } : {}) });
}

function createDeferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
