import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { deriveRegisteredToolStagedPayloadPlan } from "../adapters/registered-tool-payload-plan.js";
import { createRegisteredToolWorkerCapabilityProvider } from "../adapters/registered-tool-worker-capabilities.js";
import {
  createRoleCallLedger,
  ROLE_CAPABILITY_REFERENCE_DATA_MAX_LENGTH,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  type RoleCallFrame,
  type RoleCallLedger,
} from "../orchestration/role-calls/index.js";
import {
  createWorkerCapabilityBinding,
  type WorkerCapabilityPayloadAuthor,
} from "../orchestration/worker-capabilities/index.js";
import type { ToolRegistry } from "../ports.js";
import type {
  RegisteredToolNormalInvocation,
  ToolCallAdapter,
  ToolExecutionResult,
  ToolNormalInvocationEffect,
  ToolNormalInvocationOperation,
} from "../../capabilities/tool-types.js";

type TestContext = Readonly<{ marker: string }>;

const WORKER_CALL: RoleCallFrame = Object.freeze({
  callId: "call-2",
  parentCallId: "call-1",
  roleId: "worker",
  depth: 1,
  objective: "Inspect current system state.",
  dependencyResultRefs: [],
  status: "active",
  childCallIds: Object.freeze([]),
  activationCount: 1,
  resultRef: null,
});

const ROOT_CALL: RoleCallFrame = Object.freeze({
  callId: "call-1",
  parentCallId: null,
  roleId: "supervisor",
  depth: 0,
  objective: null,
  dependencyResultRefs: [],
  status: "active",
  childCallIds: Object.freeze([]),
  activationCount: 1,
  resultRef: null,
});

beforeEach(() => {
  configureDebugLogger({ enabled: false });
});

afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

describe("registered ordinary tool Worker capability provider", () => {
  test("rejects direct adapter execution outside the Worker call catalog scope", async () => {
    const execute = vi.fn(async () => executionResult());
    const provider = createRegisteredToolWorkerCapabilityProvider<TestContext>({
      getRequestToolRegistry: () =>
        createRegistry({
          registrations: [
            registration(
              "reader",
              [operation({ operationId: "read_state" })],
              undefined,
              ["read"],
            ),
            registration(
              "writer",
              [
                operation({
                  operationId: "write_state",
                  effect: "mutating",
                }),
              ],
              undefined,
              ["write"],
            ),
          ],
          execute,
        }),
      requestId: "request-direct-scope",
      sessionId: "session-direct-scope",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      nextApprovalId: () => "approval-unused",
    });
    const writeAdapter = provider
      .getAdapters()
      .find(({ descriptor }) => descriptor.capabilityId === "write_state");
    if (!writeAdapter) throw new Error("write adapter missing");
    const scopedCall: RoleCallFrame = Object.freeze({
      ...WORKER_CALL,
      workerCapabilityScope: Object.freeze({
        catalogGroupIds: Object.freeze(["read"]),
      }),
    });

    await expect(
      writeAdapter.execute({
        context: { marker: "context-1" },
        call: scopedCall,
        executionId: "capability-execution-1",
        intent: "Write the current state.",
        controls: {},
        settledCapabilityResults: [],
      }),
    ).rejects.toThrow(
      "registered_tool_worker_capability_provider:capability_out_of_scope:write_state",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  test("keeps an empty filtered registry frozen, lazy and memoized", () => {
    const getRequestToolRegistry = vi.fn(() =>
      createRegistry({ registrations: [], execute: vi.fn() }),
    );
    const provider = createRegisteredToolWorkerCapabilityProvider<TestContext>({
      getRequestToolRegistry,
      requestId: "request-empty",
      sessionId: "session-empty",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      nextApprovalId: () => "approval-unused",
    });

    const descriptors = provider.getDescriptors();
    const first = provider.getAdapters();
    const second = provider.getAdapters();

    expect(descriptors).toEqual([]);
    expect(Object.isFrozen(descriptors)).toBe(true);
    expect(first).toEqual([]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(second).toBe(first);
    expect(getRequestToolRegistry).toHaveBeenCalledOnce();
  });

  test("resolves selected execution guidance by registered tool name before execution", async () => {
    const timeline: string[] = [];
    const execute = vi.fn(async () => {
      timeline.push("tool.execute");
      return executionResult();
    });
    const loadActionSkillContext = vi.fn(async (toolName: string) => {
      timeline.push(`skill.load:${toolName}`);
      return "### SKILL: catalog_lookup_skill\nUse current catalog evidence.";
    });
    const provider = createRegisteredToolWorkerCapabilityProvider<TestContext>({
      getRequestToolRegistry: () =>
        createRegistry({
          registrations: [
            registration("catalog_lookup", [
              operation({
                operationId: "lookup_many",
                properties: {
                  queries: {
                    type: "array",
                    items: {
                      type: "string",
                      minLength: 1,
                      maxLength: 4_096,
                    },
                    minItems: 1,
                    maxItems: 5,
                  },
                },
                required: ["queries"],
              }),
            ]),
            registration("read_file", [
              operation({
                operationId: "read_exact_file",
                properties: {
                  path: {
                    type: "string",
                    minLength: 1,
                    maxLength: 4_096,
                  },
                },
                required: ["path"],
              }),
            ]),
          ],
          execute,
        }),
      requestId: "request-guidance",
      sessionId: "session-guidance",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      loadActionSkillContext,
      nextApprovalId: () => "approval-unused",
    });

    await expect(
      provider.getExecutionGuidance!("lookup_many"),
    ).resolves.toContain("### SKILL: catalog_lookup_skill");
    expect(loadActionSkillContext).toHaveBeenCalledExactlyOnceWith(
      "catalog_lookup",
    );
    await expect(
      provider.getExecutionGuidance!("unavailable_operation"),
    ).rejects.toThrow(
      "registered_tool_worker_capability_provider:guidance_capability_unavailable:unavailable_operation",
    );
    expect(loadActionSkillContext).toHaveBeenCalledExactlyOnceWith(
      "catalog_lookup",
    );
    expect(execute).not.toHaveBeenCalled();
    expect(timeline).toEqual(["skill.load:catalog_lookup"]);
  });

  test("projects every configured operation and executes one through the selected request registry", async () => {
    const selected = operation();
    const unselected = operation({
      operationId: "inspect_disk_state_for_path",
      properties: {
        path: { type: "string", minLength: 1, maxLength: 4_096 },
      },
      required: ["path"],
    });
    const toolResult = executionResult({
      output: "System load is low.",
      data: { currentStateEvidence: true },
    });
    const execute = vi.fn(async () => toolResult);
    const prepareSharedState = vi.fn((state = {}) => ({
      ...state,
      adapterMarker: "prepared",
    }));
    const registry = createRegistry({
      registrations: [registration("system_probe", [selected, unselected])],
      execute,
      prepareSharedState,
    });
    const getRequestToolRegistry = vi.fn(() => registry);
    const onEvent = vi.fn();
    const provider = createRegisteredToolWorkerCapabilityProvider<TestContext>({
      getRequestToolRegistry,
      requestId: "request-observe",
      sessionId: "session-observe",
      requestContext: {
        agentMode: "deep",
        toolPermissionMode: "full_access",
        modelPreference: { profileId: "luna", scope: "all" },
      },
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      nextApprovalId: () => "approval-unused",
      onEvent,
    });

    const descriptors = provider.getDescriptors();
    expect(provider.getDescriptors()).toBe(descriptors);
    expect(getRequestToolRegistry).toHaveBeenCalledOnce();
    expect(prepareSharedState).not.toHaveBeenCalled();
    expect(descriptors.map(({ capabilityId }) => capabilityId)).toEqual([
      "inspect_system_state",
      "inspect_disk_state_for_path",
    ]);
    expect(Object.isFrozen(descriptors)).toBe(true);

    const adapters = provider.getAdapters();
    expect(provider.getAdapters()).toBe(adapters);
    expect(getRequestToolRegistry).toHaveBeenCalledOnce();
    expect(prepareSharedState).toHaveBeenCalledOnce();
    expect(adapters.map(({ descriptor }) => descriptor.capabilityId)).toEqual([
      "inspect_system_state",
      "inspect_disk_state_for_path",
    ]);
    expect(adapters[0]).toEqual(
      expect.objectContaining({
        descriptor: {
          capabilityId: "inspect_system_state",
          summary: "Inspect current system state.",
          effect: "observation",
          catalogGroups: ["other"],
          controls: {
            type: "object",
            additionalProperties: false,
            properties: {},
            required: [],
          },
        },
      }),
    );
    expect(Object.isFrozen(adapters)).toBe(true);
    expect(Object.isFrozen(adapters[0]?.descriptor)).toBe(true);
    expect(Object.isFrozen(adapters[0]?.descriptor.catalogGroups)).toBe(true);
    expect(adapters[0]?.descriptor).toBe(descriptors[0]);

    await expect(
      adapters[0]!.execute({
        context: { marker: "context-1" },
        call: WORKER_CALL,
        executionId: "capability-execution-1",
        intent: "Read current load.",
        controls: {},
        settledCapabilityResults: [],
      }),
    ).resolves.toEqual(
      withRegisteredExactResult(
        {
          outcome: "succeeded",
          observedEffect: "observation",
          summary: "System load is low.",
        },
        toolResult,
      ),
    );
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      { tool: "system_probe", params: {} },
      expect.objectContaining({
        abortSignal: expect.any(AbortSignal),
        sharedState: {
          currentSessionId: "session-observe",
          requestContext: {
            agentMode: "deep",
            toolPermissionMode: "full_access",
            modelPreference: { profileId: "luna", scope: "all" },
          },
          adapterMarker: "prepared",
        },
      }),
    );
    expect(prepareSharedState).toHaveBeenCalledExactlyOnceWith({
      currentSessionId: "session-observe",
      requestContext: {
        agentMode: "deep",
        toolPermissionMode: "full_access",
        modelPreference: { profileId: "luna", scope: "all" },
      },
    });
    expect(onEvent.mock.calls.map(([name]) => name)).toEqual([
      "tool.started",
      "tool.completed",
    ]);
  });

  test("projects only manifest-owned operation targets into selection controls", () => {
    const provider = createRegisteredToolWorkerCapabilityProvider<TestContext>({
      getRequestToolRegistry: () =>
        createRegistry({
          registrations: [
            targetAwareRegistration(
              "operation_target_writer",
              "write_operation_target",
              "operation_target",
            ),
            targetAwareRegistration(
              "payload_body_writer",
              "write_payload_body",
              "payload_body",
            ),
            targetAwareRegistration(
              "unclassified_writer",
              "write_unclassified_target",
              undefined,
            ),
          ],
          execute: vi.fn(),
        }),
      requestId: "request-selection-targets",
      sessionId: "session-selection-targets",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      payloadAuthor: {
        author: vi.fn(async () => ({
          status: "authored" as const,
          body: "unused\n",
        })),
      },
      nextApprovalId: () => "approval-unused",
    });

    const descriptors = provider.getDescriptors();
    expect(descriptors).toHaveLength(3);
    expect(descriptors[0]).toMatchObject({
      capabilityId: "write_operation_target",
      selectionControlIds: ["path"],
    });
    expect(Object.isFrozen(descriptors[0]?.selectionControlIds)).toBe(true);
    expect(descriptors[1]).not.toHaveProperty("selectionControlIds");
    expect(descriptors[2]).not.toHaveProperty("selectionControlIds");
  });

  test("projects mechanical controls refinement into the Worker descriptor", () => {
    const baseRegistration = registration("mechanical_writer", [
      operation({
        operationId: "write_complete",
        effect: "mutating",
      }),
    ]);
    const provider = createRegisteredToolWorkerCapabilityProvider<TestContext>({
      getRequestToolRegistry: () =>
        createRegistry({
          registrations: [
            {
              ...baseRegistration,
              definition: {
                ...baseRegistration.definition,
                controlsRefinement: "mechanical_when_complete",
              },
            },
          ],
          execute: vi.fn(),
        }),
      requestId: "request-mechanical-controls",
      sessionId: "session-mechanical-controls",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      nextApprovalId: () => "approval-unused",
    });

    const [descriptor] = provider.getDescriptors();
    expect(descriptor).toMatchObject({
      capabilityId: "write_complete",
      controlsRefinement: "mechanical_when_complete",
    });
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(provider.getAdapters()[0]?.descriptor).toBe(descriptor);
  });

  test("leaves a non-operation target unchanged when the Worker has a working directory", async () => {
    const author = vi.fn<WorkerCapabilityPayloadAuthor["author"]>(
      async (input) => {
        expect(input.controls).toEqual({ path: "index.html" });
        return { status: "authored" as const, body: "complete body\n" };
      },
    );
    const execute = vi.fn(async () =>
      executionResult({ data: { mutationEvidence: true } }),
    );
    const provider = createRegisteredToolWorkerCapabilityProvider<TestContext>({
      getRequestToolRegistry: () =>
        createRegistry({
          registrations: [
            targetAwareRegistration(
              "payload_body_writer",
              "write_payload_body",
              "payload_body",
            ),
          ],
          execute,
        }),
      requestId: "request-payload-body-target",
      sessionId: "session-payload-body-target",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      payloadAuthor: { author },
      nextApprovalId: () => "approval-unused",
    });

    await expect(
      provider.getAdapters()[0]!.execute({
        context: { marker: "context-1" },
        call: Object.freeze({
          ...WORKER_CALL,
          workingDirectory: "Project",
        }),
        executionId: "capability-execution-payload-body",
        intent: "Write the supplied body.",
        controls: { path: "index.html" },
        settledCapabilityResults: [],
      }),
    ).resolves.toMatchObject({
      outcome: "succeeded",
      observedEffect: "mutation",
    });
    expect(author).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      {
        tool: "payload_body_writer",
        params: { path: "index.html", content: "complete body\n" },
      },
      expect.any(Object),
    );
  });

  test("applies manifest runtime path bindings to default, bare, command, and already-qualified controls", async () => {
    const agentWorkDir = await mkdtemp(join(tmpdir(), "runtime-path-binding-"));
    try {
      await mkdir(join(agentWorkDir, "Project"), { recursive: true });
      const execute = vi.fn(async () => executionResult());
      const registrations = [
        runtimePathRegistration(
          "project_orientation",
          operation({
            operationId: "inspect_project",
            properties: {
              path: { type: "string", minLength: 0, maxLength: 4_096 },
              depth: { type: "integer", minimum: 0, maximum: 6 },
            },
          }),
          [
            {
              operationId: "inspect_project",
              param: "path",
              base: "worker_working_directory",
              default: ".",
            },
          ],
        ),
        runtimePathRegistration(
          "filesystem_view",
          operation({
            operationId: "inspect_target",
            properties: {
              path: { type: "string", minLength: 1, maxLength: 4_096 },
            },
            required: ["path"],
          }),
          [
            {
              operationId: "inspect_target",
              param: "path",
              base: "worker_working_directory",
            },
          ],
        ),
        runtimePathRegistration(
          "filesystem_read",
          operation({
            operationId: "read_one_file",
            properties: {
              path: { type: "string", minLength: 1, maxLength: 4_096 },
            },
            required: ["path"],
          }),
          [
            {
              operationId: "read_one_file",
              param: "path",
              base: "worker_working_directory",
            },
          ],
        ),
        runtimePathRegistration(
          "exec",
          operation({
            operationId: "execute_command",
            properties: {
              command: { type: "string", minLength: 1, maxLength: 4_096 },
              cwd: { type: "string", minLength: 1, maxLength: 4_096 },
            },
            required: ["command", "cwd"],
            effect: "mixed",
          }),
          [
            {
              operationId: "execute_command",
              param: "cwd",
              base: "worker_working_directory",
            },
          ],
        ),
      ];
      const provider =
        createRegisteredToolWorkerCapabilityProvider<TestContext>({
          getRequestToolRegistry: () =>
            createRegistry({
              registrations,
              execute,
              prepareSharedState: (state = {}) => ({
                ...state,
                runtimePaths: { agentWorkDir },
              }),
            }),
          requestId: "request-runtime-path-bindings",
          sessionId: "session-runtime-path-bindings",
          abortSignal: new AbortController().signal,
          toolPermissionMode: "full_access",
          nextApprovalId: () => "approval-unused",
        });
      const descriptors = provider.getDescriptors();
      expect(
        descriptors.map(({ capabilityId, runtimePathControlIds }) => ({
          capabilityId,
          runtimePathControlIds,
        })),
      ).toEqual([
        {
          capabilityId: "inspect_project",
          runtimePathControlIds: ["path"],
        },
        {
          capabilityId: "inspect_target",
          runtimePathControlIds: ["path"],
        },
        {
          capabilityId: "read_one_file",
          runtimePathControlIds: ["path"],
        },
        {
          capabilityId: "execute_command",
          runtimePathControlIds: ["cwd"],
        },
      ]);
      expect(Object.isFrozen(descriptors[0]?.runtimePathControlIds)).toBe(true);
      expect(Object.keys(descriptors[3]!.controls.properties)).toEqual([
        "command",
        "cwd",
      ]);
      const adapters = new Map(
        provider
          .getAdapters()
          .map(
            (adapter) => [adapter.descriptor.capabilityId, adapter] as const,
          ),
      );
      const call = Object.freeze({
        ...WORKER_CALL,
        workingDirectory: "Project",
      });
      const bareReadControls = Object.freeze({ path: "content/post.md" });

      await adapters.get("inspect_project")!.execute({
        context: { marker: "context-project" },
        call,
        executionId: "capability-execution-project",
        intent: "Inspect the project.",
        controls: { depth: 2 },
        settledCapabilityResults: [],
      });
      await adapters.get("inspect_target")!.execute({
        context: { marker: "context-inspect" },
        call,
        executionId: "capability-execution-inspect",
        intent: "Inspect the entrypoint.",
        controls: { path: "index.html" },
        settledCapabilityResults: [],
      });
      await adapters.get("read_one_file")!.execute({
        context: { marker: "context-read" },
        call,
        executionId: "capability-execution-read",
        intent: "Read the post.",
        controls: bareReadControls,
        settledCapabilityResults: [],
      });
      await adapters.get("execute_command")!.execute({
        context: { marker: "context-exec" },
        call,
        executionId: "capability-execution-exec",
        intent: "Run the project test.",
        controls: { command: "npm test", cwd: "." },
        settledCapabilityResults: [],
      });
      await adapters.get("inspect_target")!.execute({
        context: { marker: "context-qualified" },
        call,
        executionId: "capability-execution-qualified",
        intent: "Inspect the qualified entrypoint.",
        controls: { path: "Project/index.html" },
        settledCapabilityResults: [],
      });

      expect(execute.mock.calls.map(([toolCall]) => toolCall)).toEqual([
        { tool: "project_orientation", params: { depth: 2, path: "Project" } },
        { tool: "filesystem_view", params: { path: "Project/index.html" } },
        {
          tool: "filesystem_read",
          params: { path: "Project/content/post.md" },
        },
        { tool: "exec", params: { command: "npm test", cwd: "Project" } },
        { tool: "filesystem_view", params: { path: "Project/index.html" } },
      ]);
      expect(bareReadControls).toEqual({ path: "content/post.md" });
      expect(Object.isFrozen(bareReadControls)).toBe(true);
    } finally {
      await rm(agentWorkDir, { recursive: true, force: true });
    }
  });

  test("rejects a manifest runtime path binding absent from operation controls", () => {
    const readOperation = operation({
      operationId: "read_one_file",
      properties: {
        target: { type: "string", minLength: 1, maxLength: 4_096 },
      },
      required: ["target"],
    });
    const base = registration("invalid_runtime_path_binding", [readOperation]);
    const provider = createRegisteredToolWorkerCapabilityProvider<TestContext>({
      getRequestToolRegistry: () =>
        createRegistry({
          registrations: [
            {
              ...base,
              definition: {
                ...base.definition,
                params: { ...base.definition.params, path: "string" },
                runtimePathBindings: [
                  {
                    operationId: "read_one_file",
                    param: "path",
                    base: "worker_working_directory",
                  },
                ],
              },
            },
          ],
          execute: vi.fn(),
        }),
      requestId: "request-invalid-runtime-path-control",
      sessionId: "session-invalid-runtime-path-control",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      nextApprovalId: () => "approval-unused",
    });

    expect(() => provider.getDescriptors()).toThrow(
      "registered_tool_worker_capability_provider:operation_runtime_path_control_invalid:read_one_file",
    );
  });

  test("rejects a manifest-bound explicit path outside the Worker directory before execution", async () => {
    const agentWorkDir = await mkdtemp(join(tmpdir(), "runtime-path-reject-"));
    const workspaceDir = join(agentWorkDir, "workspace-root");
    try {
      await Promise.all([
        mkdir(join(agentWorkDir, "Project"), { recursive: true }),
        mkdir(workspaceDir, { recursive: true }),
      ]);
      const execute = vi.fn(async () => executionResult());
      const provider =
        createRegisteredToolWorkerCapabilityProvider<TestContext>({
          getRequestToolRegistry: () =>
            createRegistry({
              registrations: [
                runtimePathRegistration(
                  "filesystem_read",
                  operation({
                    operationId: "read_one_file",
                    properties: {
                      path: { type: "string", minLength: 1, maxLength: 4_096 },
                    },
                    required: ["path"],
                  }),
                  [
                    {
                      operationId: "read_one_file",
                      param: "path",
                      base: "worker_working_directory",
                    },
                  ],
                ),
              ],
              execute,
              prepareSharedState: (state = {}) => ({
                ...state,
                runtimePaths: { agentWorkDir, workspaceDir },
              }),
            }),
          requestId: "request-runtime-path-rejection",
          sessionId: "session-runtime-path-rejection",
          abortSignal: new AbortController().signal,
          toolPermissionMode: "full_access",
          nextApprovalId: () => "approval-unused",
        });

      await expect(
        provider.getAdapters()[0]!.execute({
          context: { marker: "context-rejection" },
          call: Object.freeze({ ...WORKER_CALL, workingDirectory: "Project" }),
          executionId: "capability-execution-rejection",
          intent: "Read an out-of-scope workspace file.",
          controls: { path: "workspace/shared.txt" },
          settledCapabilityResults: [],
        }),
      ).rejects.toThrow(
        "registered_tool_worker_capability_execution:runtime_target_path_outside_working_directory",
      );
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await rm(agentWorkDir, { recursive: true, force: true });
    }
  });

  test("rejects operation-target traversal before authoring or execution without logging the raw path", async () => {
    configureDebugLogger({ enabled: true });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const author = vi.fn<WorkerCapabilityPayloadAuthor["author"]>(async () => ({
      status: "authored" as const,
      body: "must not be authored\n",
    }));
    const execute = vi.fn(async () =>
      executionResult({ data: { mutationEvidence: true } }),
    );
    const provider = createRegisteredToolWorkerCapabilityProvider<TestContext>({
      getRequestToolRegistry: () =>
        createRegistry({
          registrations: [
            targetAwareRegistration(
              "operation_target_writer",
              "write_operation_target",
              "operation_target",
            ),
          ],
          execute,
          prepareSharedState: (state = {}) => ({
            ...state,
            runtimePaths: { agentWorkDir: process.cwd() },
          }),
        }),
      requestId: "request-operation-target-traversal",
      sessionId: "session-operation-target-traversal",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      payloadAuthor: { author },
      nextApprovalId: () => "approval-unused",
    });

    await expect(
      provider.getAdapters()[0]!.execute({
        context: { marker: "context-1" },
        call: Object.freeze({
          ...WORKER_CALL,
          workingDirectory: "Project",
        }),
        executionId: "capability-execution-traversal",
        intent: "Write outside the project.",
        controls: { path: "../outside-secret.txt" },
        settledCapabilityResults: [],
      }),
    ).rejects.toThrow(
      "registered_tool_worker_capability_execution:runtime_target_path_traversal",
    );
    expect(author).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.registered_tool_worker_capabilities",
          event: "adapter.execution_failed",
          protocolIssueCode: "runtime_target_path_traversal",
        }),
      ]),
    );
    expect(JSON.stringify(logs)).not.toContain("outside-secret.txt");
  });

  test("rejects an operation target role without a public target control", () => {
    const writeOperation = operation({
      operationId: "write_invalid_operation_target",
      properties: {
        path: { type: "string", minLength: 1, maxLength: 4_096 },
      },
      required: ["path"],
      payload: {
        kind: "raw_text",
        param: "content",
        instructions: "Return the complete body.",
        maxBytes: 1_024,
      },
      effect: "mutating",
    });
    const base = registration("invalid_operation_target_writer", [
      writeOperation,
    ]);
    const invalidRegistration: RegisteredToolNormalInvocation = {
      ...base,
      definition: {
        ...base.definition,
        payloadChannelSpec: {
          params: ["content"],
          outputParam: "content",
          generationMode: "raw_text",
          targetRole: "operation_target",
        },
      },
    };
    const provider = createRegisteredToolWorkerCapabilityProvider<TestContext>({
      getRequestToolRegistry: () =>
        createRegistry({
          registrations: [invalidRegistration],
          execute: vi.fn(),
        }),
      requestId: "request-invalid-selection-target",
      sessionId: "session-invalid-selection-target",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      payloadAuthor: {
        author: vi.fn(async () => ({
          status: "authored" as const,
          body: "unused\n",
        })),
      },
      nextApprovalId: () => "approval-unused",
    });

    expect(() => provider.getDescriptors()).toThrow(
      "registered_tool_worker_capability_provider:operation_target_control_invalid:write_invalid_operation_target",
    );
  });

  test.each([
    {
      label: "explicit mutation evidence",
      result: executionResult({
        data: { mutationEvidence: true },
      }),
      expected: {
        outcome: "succeeded",
        observedEffect: "mutation",
        summary: "The mutation capability reported a completed change.",
      },
    },
    {
      label: "bounded mutation grounding",
      result: executionResult({
        data: {
          mutationEvidence: true,
          mutationGrounding:
            "Post-mutation artifact grounding:\n- content: bytes=42; lines=3",
        },
      }),
      expected: {
        outcome: "succeeded",
        observedEffect: "mutation",
        summary: "The mutation capability reported a completed change.",
        referenceData:
          "Post-mutation artifact grounding:\n- content: bytes=42; lines=3",
      },
    },
    {
      label: "current-state evidence without mutation",
      result: executionResult({
        data: { currentStateEvidence: true },
      }),
      expected: {
        outcome: "failed",
        observedEffect: "observation",
        summary: "Current system state.",
      },
    },
    {
      label: "no mutation evidence",
      result: executionResult(),
      expected: {
        outcome: "failed",
        observedEffect: "none",
        summary: "Current system state.",
      },
    },
  ])(
    "projects exact public controls and maps $label conservatively",
    async ({ result, expected }) => {
      const execute = vi.fn(async () => result);
      const provider =
        createRegisteredToolWorkerCapabilityProvider<TestContext>({
          getRequestToolRegistry: () =>
            createRegistry({
              registrations: [
                registration("mutator", [
                  operation({
                    operationId: "mutate_one_value",
                    summary: "Mutate one exact selected value.",
                    properties: {
                      path: {
                        type: "string",
                        minLength: 1,
                        maxLength: 4_096,
                      },
                    },
                    required: ["path"],
                    effect: "mutating",
                  }),
                ]),
              ],
              execute,
            }),
          requestId: "request-mutation-controls",
          sessionId: "session-mutation-controls",
          abortSignal: new AbortController().signal,
          toolPermissionMode: "full_access",
          nextApprovalId: () => "approval-unused",
        });

      const adapter = provider.getAdapters()[0]!;
      expect(adapter.descriptor).toEqual({
        capabilityId: "mutate_one_value",
        summary: "Mutate one exact selected value.",
        effect: "mutation",
        catalogGroups: ["other"],
        controls: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", minLength: 1, maxLength: 4_096 },
          },
          required: ["path"],
        },
      });
      await expect(
        adapter.execute({
          context: { marker: "context-1" },
          call: WORKER_CALL,
          executionId: "capability-execution-1",
          intent: "Mutate the selected value.",
          controls: { path: "project/result.txt" },
          settledCapabilityResults: [],
        }),
      ).resolves.toEqual(withRegisteredExactResult(expected, result));
      expect(execute).toHaveBeenCalledExactlyOnceWith(
        {
          tool: "mutator",
          params: { path: "project/result.txt" },
        },
        expect.any(Object),
      );
    },
  );

  test.each([
    {
      label: "observation",
      result: executionResult({
        output: "Observed the current project state.",
        data: { currentStateEvidence: true },
      }),
      expected: {
        outcome: "succeeded",
        observedEffect: "observation",
        summary: "Observed the current project state.",
      },
    },
    {
      label: "mutation",
      result: executionResult({
        output: "Changed one project file.",
        data: { mutationEvidence: true },
      }),
      expected: {
        outcome: "succeeded",
        observedEffect: "mutation",
        summary: "The mutation capability reported a completed change.",
      },
    },
  ])(
    "reports a mixed operation's concrete $label effect",
    async ({ result, expected }) => {
      const provider =
        createRegisteredToolWorkerCapabilityProvider<TestContext>({
          getRequestToolRegistry: () =>
            createRegistry({
              registrations: [
                registration("exec", [
                  operation({
                    operationId: "execute_command",
                    summary: "Execute one bounded command.",
                    effect: "mixed",
                  }),
                ]),
              ],
              execute: vi.fn(async () => result),
            }),
          requestId: `request-mixed-${expected.observedEffect}`,
          sessionId: "session-mixed",
          abortSignal: new AbortController().signal,
          toolPermissionMode: "full_access",
          nextApprovalId: () => "approval-unused",
        });

      const adapter = provider.getAdapters()[0]!;
      expect(adapter.descriptor.effect).toBe("mixed");
      await expect(
        adapter.execute({
          context: { marker: "context-1" },
          call: WORKER_CALL,
          executionId: "capability-execution-1",
          intent: "Execute the bounded command.",
          controls: {},
          settledCapabilityResults: [],
        }),
      ).resolves.toEqual(withRegisteredExactResult(expected, result));
    },
  );

  test("authors one fake mutation payload and preserves the existing payload/tool lifecycle", async () => {
    configureDebugLogger({ enabled: true });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const physicalTarget =
      "/private/runtime/agent-work/request-fake-payload/result.txt";
    const resumedCall = Object.freeze({
      ...WORKER_CALL,
      activationCount: 2,
    });
    const settledCapabilityResults = Object.freeze([
      Object.freeze({
        executionId: "capability-execution-1",
        callId: resumedCall.callId,
        invocationAttempt: 1,
        capabilityId: "inspect_system_state",
        declaredEffect: "observation" as const,
        outcome: "succeeded" as const,
        observedEffect: "observation" as const,
        summary: "Observed total memory: 31.2 GiB.",
        adapterResult: Object.freeze({
          kind: "generic_capability_result_v1" as const,
          authority: "capability_adapter" as const,
          status: "executed" as const,
          ok: true,
          payload: Object.freeze({
            outcome: "succeeded" as const,
            observedEffect: "observation" as const,
            summary: "Observed total memory: 31.2 GiB.",
          }),
        }),
      }),
    ]);
    const author = vi.fn<WorkerCapabilityPayloadAuthor["author"]>(
      async (input) => {
        expect(input).toMatchObject({
          call: resumedCall,
          executionId: "capability-execution-2",
          descriptor: {
            capabilityId: "write_test_artifact",
            summary: "Write one complete test artifact.",
            effect: "mutation",
          },
          controls: { path: "project/result.txt" },
          settledCapabilityResults,
          contract: {
            instructions: "Return the complete artifact body.",
            maxBytes: 1_024,
          },
        });
        expect(input).not.toHaveProperty("intent");
        return Object.freeze({
          status: "authored" as const,
          body: "hello from payload\n",
        });
      },
    );
    const toolResult = executionResult({
      tool: "write_file",
      output: `Artifact created at ${physicalTarget}.`,
      actions: [
        {
          type: "establish_target",
          target: physicalTarget,
          details: "implementation-only mutation details",
        },
      ],
      data: { mutationEvidence: true },
    });
    const execute = vi.fn(async () => toolResult);
    const onEvent = vi.fn();
    const provider = createRegisteredToolWorkerCapabilityProvider<TestContext>({
      getRequestToolRegistry: () =>
        createRegistry({
          registrations: [
            registration("write_file", [
              operation({
                operationId: "write_test_artifact",
                summary: "Write one complete test artifact.",
                properties: {
                  path: {
                    type: "string",
                    minLength: 1,
                    maxLength: 4_096,
                  },
                },
                required: ["path"],
                payload: {
                  kind: "raw_text",
                  param: "content",
                  instructions: "Return the complete artifact body.",
                  maxBytes: 1_024,
                },
                effect: "mutating",
              }),
            ]),
          ],
          execute,
        }),
      requestId: "request-fake-payload",
      sessionId: "session-fake-payload",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      payloadAuthor: { author },
      nextApprovalId: () => "approval-unused",
      onEvent,
    });

    await expect(
      provider.getAdapters()[0]!.execute({
        context: { marker: "context-1" },
        call: resumedCall,
        executionId: "capability-execution-2",
        intent: "Create the requested test artifact.",
        controls: { path: "project/result.txt" },
        settledCapabilityResults,
      }),
    ).resolves.toEqual(
      withRegisteredExactResult(
        {
          outcome: "succeeded",
          observedEffect: "mutation",
          summary:
            "The mutation capability completed these logical effects:\n- establish_target",
        },
        toolResult,
      ),
    );
    expect(author).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      {
        tool: "write_file",
        params: {
          path: "project/result.txt",
          content: "hello from payload\n",
        },
      },
      expect.any(Object),
    );
    expect(onEvent.mock.calls.map(([name]) => name)).toEqual([
      "tool.payload.started",
      "tool.payload.completed",
      "tool.started",
      "tool.completed",
    ]);
    expect(
      onEvent.mock.calls.find(([name]) => name === "tool.started")?.[1],
    ).toMatchObject({
      intent: "Create the requested test artifact.",
      intentSource: "model",
    });
    expect(onEvent.mock.calls.at(-1)?.[1]).toMatchObject({
      tool: "write_file",
      ok: true,
      actions: [
        {
          type: "establish_target",
        },
      ],
    });
    const diagnosticLogs = consoleLog.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter(
        (entry) =>
          entry.scope === "runtime.registered_tool_worker_capabilities",
      );
    expect(diagnosticLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "adapter.execution_completed",
          summaryProjection: "logical_completion_actions",
          completionActionCount: 1,
          completionActionTypes: ["establish_target"],
          logicalTargetCount: 0,
          logicalTargetLengths: [],
        }),
      ]),
    );
    expect(JSON.stringify(diagnosticLogs)).not.toContain(physicalTarget);
  });

  test("preserves the selected target when an executed mutation fails without completion actions", async () => {
    const writeOperation = operation({
      operationId: "write_test_artifact",
      summary: "Write one complete test artifact.",
      properties: {
        path: { type: "string", minLength: 1, maxLength: 4_096 },
      },
      required: ["path"],
      payload: {
        kind: "raw_text",
        param: "content",
        instructions: "Return the complete artifact body.",
        maxBytes: 1_024,
      },
      effect: "mutating",
    });
    const baseRegistration = registration("write_file", [writeOperation]);
    const targetAwareRegistration: RegisteredToolNormalInvocation = {
      ...baseRegistration,
      definition: {
        ...baseRegistration.definition,
        payloadChannelSpec: {
          params: ["content"],
          outputParam: "content",
          generationMode: "raw_text",
          targetParam: "path",
          targetRole: "operation_target",
          contextScope: "standard",
        },
      },
    };
    const toolResult = executionResult({
      ok: false,
      tool: "write_file",
      output: "Generated CSS did not pass syntax validation.",
      producedNewInformation: false,
      actions: [],
      error: "Generated CSS did not pass syntax validation.",
      errorCode: "file_syntax_repair_invalid",
    });
    const provider = createRegisteredToolWorkerCapabilityProvider<TestContext>({
      getRequestToolRegistry: () =>
        createRegistry({
          registrations: [targetAwareRegistration],
          execute: vi.fn(async () => toolResult),
        }),
      requestId: "request-failed-targeted-write",
      sessionId: "session-failed-targeted-write",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      payloadAuthor: {
        author: vi.fn(async (input) => {
          expect(input.contextScope).toBe("standard");
          return {
            status: "authored" as const,
            body: "body { color: red; }\n",
          };
        }),
      },
      nextApprovalId: () => "approval-unused",
    });

    expect(provider.getDescriptors()[0]).toMatchObject({
      capabilityId: "write_test_artifact",
      selectionControlIds: ["path"],
      runtimePathControlIds: ["path"],
    });
    expect(
      Object.isFrozen(provider.getDescriptors()[0]?.selectionControlIds),
    ).toBe(true);
    expect(
      Object.isFrozen(provider.getDescriptors()[0]?.runtimePathControlIds),
    ).toBe(true);

    await expect(
      provider.getAdapters()[0]!.execute({
        context: { marker: "context-1" },
        call: WORKER_CALL,
        executionId: "capability-execution-1",
        intent: "Create the stylesheet.",
        controls: { path: "project/style.css" },
        settledCapabilityResults: [],
      }),
    ).resolves.toEqual(
      withRegisteredExactResult(
        {
          outcome: "failed",
          observedEffect: "none",
          summary: "Generated CSS did not pass syntax validation.",
          references: [{ kind: "tool_target", target: "project/style.css" }],
        },
        toolResult,
        [{ kind: "tool_target", target: "project/style.css" }],
      ),
    );
  });

  test.each([
    { placement: "before" },
    { placement: "after" },
    { placement: "replace" },
  ] as const)(
    "blocks empty $placement edit content before the registered tool boundary",
    async ({ placement }) => {
      const author = vi.fn<WorkerCapabilityPayloadAuthor["author"]>(
        async (input) => {
          if (input.stage?.index === 1) {
            expect(input.contract.minBytes).toBe(0);
            return {
              status: "authored" as const,
              body: JSON.stringify({ placement }),
            };
          }
          expect(input.stage?.index).toBe(2);
          expect(input.materializedParams).toEqual({
            selection: JSON.stringify({ placement }),
          });
          expect(input.contract.minBytes).toBe(1);
          return { status: "authored" as const, body: "" };
        },
      );
      const execute = vi.fn();
      const onEvent = vi.fn();
      const provider =
        createRegisteredToolWorkerCapabilityProvider<TestContext>({
          getRequestToolRegistry: () =>
            createRegistry({
              registrations: [conditionalStagedPayloadRegistration()],
              execute,
            }),
          requestId: `request-conditional-empty-${placement}`,
          sessionId: "session-conditional-empty",
          abortSignal: new AbortController().signal,
          toolPermissionMode: "full_access",
          payloadAuthor: { author },
          nextApprovalId: () => "approval-unused",
          onEvent,
        });

      await expect(
        provider.getAdapters()[0]!.execute({
          context: { marker: "context-1" },
          call: WORKER_CALL,
          executionId: "capability-execution-1",
          intent: `Apply the selected ${placement} edit.`,
          controls: { instruction: `Apply the ${placement} edit.` },
          settledCapabilityResults: [],
        }),
      ).resolves.toEqual(
        withRuntimeRejectionExactResult(
          {
            outcome: "failed",
            observedEffect: "none",
            summary: "The capability payload could not be prepared.",
          },
          "payload_body_too_small",
          "The capability payload could not be prepared.",
        ),
      );
      expect(author).toHaveBeenCalledTimes(2);
      expect(execute).not.toHaveBeenCalled();
      expect(onEvent).toHaveBeenLastCalledWith(
        "tool.payload.failed",
        expect.objectContaining({
          payloadStage: 2,
          outputParam: "content",
          error: "payload_body_too_small",
        }),
      );
    },
  );

  test("materializes an empty delete literal without a second author call and preserves the full lifecycle", async () => {
    configureDebugLogger({ enabled: true });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const author = vi.fn<WorkerCapabilityPayloadAuthor["author"]>(
      async (input) => {
        expect(input.stage?.index).toBe(1);
        return {
          status: "authored" as const,
          body: JSON.stringify({ placement: "delete" }),
        };
      },
    );
    const execute = vi.fn(async () =>
      executionResult({ data: { mutationEvidence: true } }),
    );
    const onEvent = vi.fn();
    const provider = createRegisteredToolWorkerCapabilityProvider<TestContext>({
      getRequestToolRegistry: () =>
        createRegistry({
          registrations: [conditionalStagedPayloadRegistration()],
          execute,
        }),
      requestId: "request-conditional-delete",
      sessionId: "session-conditional-delete",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      payloadAuthor: { author },
      nextApprovalId: () => "approval-unused",
      onEvent,
    });

    await expect(
      provider.getAdapters()[0]!.execute({
        context: { marker: "context-1" },
        call: WORKER_CALL,
        executionId: "capability-execution-1",
        intent: "Delete the selected material.",
        controls: { instruction: "Delete the selected material." },
        settledCapabilityResults: [],
      }),
    ).resolves.toMatchObject({
      outcome: "succeeded",
      observedEffect: "mutation",
    });
    expect(author).toHaveBeenCalledOnce();
    expect(author.mock.calls[0]?.[0].stage).toMatchObject({
      index: 1,
      count: 2,
      outputParam: "selection",
    });
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      {
        tool: "conditional_editor",
        params: {
          instruction: "Delete the selected material.",
          selection: '{"placement":"delete"}',
          content: "",
        },
      },
      expect.any(Object),
    );
    expect(
      onEvent.mock.calls.map(([name, payload]) => [
        name,
        payload.payloadStage,
        payload.payloadStageCount,
        payload.outputParam,
      ]),
    ).toEqual([
      ["tool.payload.started", 1, 2, "selection"],
      ["tool.payload.completed", 1, 2, "selection"],
      ["tool.payload.started", 2, 2, "content"],
      ["tool.payload.completed", 2, 2, "content"],
      ["tool.started", undefined, undefined, undefined],
      ["tool.completed", undefined, undefined, undefined],
    ]);
    const materializedDiagnostics = consoleLog.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter(
        (entry) =>
          entry.scope === "runtime.registered_tool_worker_capabilities" &&
          entry.event === "adapter.payload_stage_materialized",
      );
    expect(materializedDiagnostics).toHaveLength(1);
    expect(materializedDiagnostics[0]).toMatchObject({
      payloadStage: 2,
      payloadStageCount: 2,
      source: "manifest_literal",
      byteCount: 0,
    });
    expect(
      Object.keys(materializedDiagnostics[0]!).filter((key) =>
        /literal|condition|value|body/u.test(key),
      ),
    ).toEqual([]);
  });

  test("keeps authoring the final payload stage when the literal condition does not match", async () => {
    const author = vi.fn<WorkerCapabilityPayloadAuthor["author"]>(
      async (input) => {
        if (input.stage?.index === 1) {
          return {
            status: "authored" as const,
            body: JSON.stringify({ placement: "replace" }),
          };
        }
        expect(input.stage?.index).toBe(2);
        expect(input.materializedParams).toEqual({
          selection: '{"placement":"replace"}',
        });
        expect(input.contract.minBytes).toBe(1);
        return { status: "authored" as const, body: "replacement" };
      },
    );
    const execute = vi.fn(async () =>
      executionResult({ data: { mutationEvidence: true } }),
    );
    const provider = createRegisteredToolWorkerCapabilityProvider<TestContext>({
      getRequestToolRegistry: () =>
        createRegistry({
          registrations: [conditionalStagedPayloadRegistration()],
          execute,
        }),
      requestId: "request-conditional-replace",
      sessionId: "session-conditional-replace",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      payloadAuthor: { author },
      nextApprovalId: () => "approval-unused",
    });

    await expect(
      provider.getAdapters()[0]!.execute({
        context: { marker: "context-1" },
        call: WORKER_CALL,
        executionId: "capability-execution-1",
        intent: "Replace the selected material.",
        controls: { instruction: "Replace the selected material." },
        settledCapabilityResults: [],
      }),
    ).resolves.toMatchObject({
      outcome: "succeeded",
      observedEffect: "mutation",
    });
    expect(author).toHaveBeenCalledTimes(2);
    expect(author.mock.calls.map(([input]) => input.stage?.index)).toEqual([
      1, 2,
    ]);
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      {
        tool: "conditional_editor",
        params: {
          instruction: "Replace the selected material.",
          selection: '{"placement":"replace"}',
          content: "replacement",
        },
      },
      expect.any(Object),
    );
  });

  test("rejects schema-invalid structured output from a custom author before resolving the delete override", async () => {
    const secretProperty = "MODEL_SECRET_PROPERTY_MUST_NOT_ESCAPE";
    const author = vi.fn<WorkerCapabilityPayloadAuthor["author"]>(async () => ({
      status: "authored" as const,
      body: JSON.stringify({ placement: "delete", [secretProperty]: true }),
    }));
    const execute = vi.fn();
    const onEvent = vi.fn();
    const provider = createRegisteredToolWorkerCapabilityProvider<TestContext>({
      getRequestToolRegistry: () =>
        createRegistry({
          registrations: [conditionalStagedPayloadRegistration()],
          execute,
        }),
      requestId: "request-conditional-schema-invalid",
      sessionId: "session-conditional-schema-invalid",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      payloadAuthor: { author },
      nextApprovalId: () => "approval-unused",
      onEvent,
    });

    await expect(
      provider.getAdapters()[0]!.execute({
        context: { marker: "context-1" },
        call: WORKER_CALL,
        executionId: "capability-execution-1",
        intent: "Delete the selected material.",
        controls: { instruction: "Delete the selected material." },
        settledCapabilityResults: [],
      }),
    ).resolves.toEqual(
      withRuntimeRejectionExactResult(
        {
          outcome: "failed",
          observedEffect: "none",
          summary: "The capability payload could not be prepared.",
        },
        "payload_model_output_invalid",
        "The capability payload could not be prepared.",
      ),
    );
    expect(author).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenLastCalledWith(
      "tool.payload.failed",
      expect.objectContaining({
        payloadStage: 1,
        outputParam: "selection",
        error: "payload_model_output_invalid",
      }),
    );
    expect(JSON.stringify(onEvent.mock.calls)).not.toContain(secretProperty);
  });

  test.each([
    { label: "malformed JSON", body: "not json" },
    { label: "a non-string condition property", body: '{"placement":1}' },
  ])(
    "fails closed on $label in the conditional stage dependency",
    async ({ body }) => {
      const author = vi.fn<WorkerCapabilityPayloadAuthor["author"]>(
        async () => ({ status: "authored" as const, body }),
      );
      const execute = vi.fn();
      const onEvent = vi.fn();
      const provider =
        createRegisteredToolWorkerCapabilityProvider<TestContext>({
          getRequestToolRegistry: () =>
            createRegistry({
              registrations: [conditionalStagedPayloadRegistration()],
              execute,
            }),
          requestId: "request-conditional-dependency-invalid",
          sessionId: "session-conditional-dependency-invalid",
          abortSignal: new AbortController().signal,
          toolPermissionMode: "full_access",
          payloadAuthor: { author },
          nextApprovalId: () => "approval-unused",
          onEvent,
        });

      await expect(
        provider.getAdapters()[0]!.execute({
          context: { marker: "context-1" },
          call: WORKER_CALL,
          executionId: "capability-execution-1",
          intent: "Apply one staged edit.",
          controls: { instruction: "Apply one staged edit." },
          settledCapabilityResults: [],
        }),
      ).resolves.toEqual(
        withRuntimeRejectionExactResult(
          {
            outcome: "failed",
            observedEffect: "none",
            summary: "The capability payload could not be prepared.",
          },
          "payload_model_output_invalid",
          "The capability payload could not be prepared.",
        ),
      );
      expect(author).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
      expect(onEvent).toHaveBeenLastCalledWith(
        "tool.payload.failed",
        expect.objectContaining({
          payloadStage: 1,
          error: "payload_model_output_invalid",
        }),
      );
    },
  );

  test("rejects a conditional stage whose declared dependency is missing", () => {
    const registration = conditionalStagedPayloadRegistration();
    const stages = registration.definition.payloadChannelSpec?.stages;
    if (!stages) throw new Error("missing staged test definition");
    const malformed: RegisteredToolNormalInvocation = {
      ...registration,
      definition: {
        ...registration.definition,
        payloadChannelSpec: {
          ...registration.definition.payloadChannelSpec!,
          stages: [
            stages[0]!,
            { ...stages[1]!, includeMaterializedParams: [] },
          ],
        },
      },
    };
    const author = vi.fn<WorkerCapabilityPayloadAuthor["author"]>();
    const execute = vi.fn();
    const provider = createRegisteredToolWorkerCapabilityProvider<TestContext>({
      getRequestToolRegistry: () =>
        createRegistry({ registrations: [malformed], execute }),
      requestId: "request-conditional-dependency-missing",
      sessionId: "session-conditional-dependency-missing",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      payloadAuthor: { author },
      nextApprovalId: () => "approval-unused",
    });

    expect(() => provider.getAdapters()).toThrow(
      "registered_tool_worker_capability_provider:resolution_failed",
    );
    expect(author).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  test("rejects a staged literal below the operation payload minimum", () => {
    const registration = conditionalStagedPayloadRegistration();
    const operation = registration.contract.operations[0]!;
    const malformed: RegisteredToolNormalInvocation = {
      ...registration,
      contract: {
        ...registration.contract,
        operations: [
          {
            ...operation,
            payload: {
              ...operation.payload!,
              minBytes: 1,
            },
          },
        ],
      },
    };
    const provider = createRegisteredToolWorkerCapabilityProvider<TestContext>({
      getRequestToolRegistry: () =>
        createRegistry({ registrations: [malformed], execute: vi.fn() }),
      requestId: "request-conditional-minimum-weakened",
      sessionId: "session-conditional-minimum-weakened",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      payloadAuthor: {
        author: vi.fn(async () => ({
          status: "authored" as const,
          body: "unused",
        })),
      },
      nextApprovalId: () => "approval-unused",
    });

    expect(() => provider.getAdapters()).toThrow(
      "registered_tool_worker_capability_provider:resolution_failed",
    );
  });

  test("projects staged literal output into a detached deeply frozen plan", () => {
    const registration = conditionalStagedPayloadRegistration();
    const operation = registration.contract.operations[0]!;
    const sourceLiteral =
      registration.definition.payloadChannelSpec?.stages?.[1]?.literalOutput;
    if (!sourceLiteral) throw new Error("missing staged literal output");

    const plan = deriveRegisteredToolStagedPayloadPlan(
      registration.definition,
      operation,
    );
    const projectedLiteral = plan?.stages[1]?.literalOutput;

    expect(projectedLiteral).toEqual({
      when: {
        materializedParam: "selection",
        property: "placement",
        equals: "delete",
      },
      value: "",
    });
    expect(projectedLiteral).not.toBe(sourceLiteral);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan?.stages)).toBe(true);
    expect(Object.isFrozen(plan?.stages[1])).toBe(true);
    expect(Object.isFrozen(projectedLiteral)).toBe(true);
    expect(Object.isFrozen(projectedLiteral?.when)).toBe(true);

    (
      sourceLiteral as {
        when: { property: string };
      }
    ).when.property = "changed_after_projection";
    expect(projectedLiteral?.when.property).toBe("placement");
  });

  test("authors registered structured and raw edit stages before validating and executing one complete call", async () => {
    const agentWorkDir = await mkdtemp(join(tmpdir(), "runtime-staged-edit-"));
    try {
      await mkdir(join(agentWorkDir, "Project"), { recursive: true });
      await writeFile(
        join(agentWorkDir, "Project", "target.txt"),
        "before\nkeep\n",
        "utf8",
      );
      await writeFile(join(agentWorkDir, "related.css"), "stale\n", "utf8");
      const resumedWorkerCall = Object.freeze({
        ...WORKER_CALL,
        activationCount: 2,
        workingDirectory: "Project",
      });
      const settledCapabilityResults = Object.freeze([
        Object.freeze({
          executionId: "capability-execution-related",
          callId: resumedWorkerCall.callId,
          invocationAttempt: 1,
          capabilityId: "write_complete_file",
          declaredEffect: "mutation" as const,
          outcome: "succeeded" as const,
          observedEffect: "mutation" as const,
          summary: "Related artifacts were created.",
          adapterResult: {
            kind: "generic_capability_result_v1" as const,
            authority: "capability_adapter" as const,
            status: "executed" as const,
            ok: true,
            payload: {
              outcome: "succeeded",
              observedEffect: "mutation",
              summary: "Related artifacts were created.",
            },
          },
          references: Object.freeze([
            Object.freeze({
              kind: "tool_target" as const,
              target: "target.txt",
            }),
            Object.freeze({
              kind: "tool_target" as const,
              target: "related.css",
            }),
            Object.freeze({
              kind: "tool_target" as const,
              target: "missing.js",
            }),
          ]),
        }),
      ]);
      let selectedLine = 1;
      const author = vi.fn<WorkerCapabilityPayloadAuthor["author"]>(
        async (input) => {
          if (input.stage?.index === 1) {
            expect(input.contextScope).toBe("target_only");
            expect(Object.isFrozen(input.controls)).toBe(true);
            expect(input.controls).toEqual({
              path: "Project/target.txt",
              instruction: "Replace the first line.",
            });
            expect(input.stage).toEqual({
              index: 1,
              count: 2,
              outputParam: "selection",
              contextScope: "target_only",
            });
            expect(input.contract.responseFormat).toEqual({
              type: "object",
              properties: {
                placement: { type: "string" },
                start_line: { type: "integer", maximum: 3 },
                end_line: { type: "integer", maximum: 3 },
              },
              required: ["placement", "start_line", "end_line"],
            });
            expect(input.targetContext).toMatchObject({
              targetParam: "path",
              targetPath: "Project/target.txt",
              presentation: "full_numbered",
              content: "1 | before\n2 | keep\n3 | ",
            });
            expect(input.materializedParams).toBeUndefined();
            expect(input.relatedArtifactContexts).toBeUndefined();
            return {
              status: "authored" as const,
              body: JSON.stringify({
                placement: "replace",
                start_line: selectedLine,
                end_line: selectedLine,
              }),
            };
          }
          expect(input.contextScope).toBe("target_with_artifacts");
          expect(input.stage).toEqual({
            index: 2,
            count: 2,
            outputParam: "content",
            contextScope: "target_with_artifacts",
          });
          expect(input.contract.responseFormat).toBeUndefined();
          expect(input.materializedParams).toEqual({
            selection: '{"placement":"replace","start_line":1,"end_line":1}',
          });
          expect(input.targetContext).toMatchObject({
            targetPath: "Project/target.txt",
            presentation: "bounded",
            content: "before\nkeep",
            sourceRange: {
              contextStartLine: 1,
              contextEndLine: 2,
              writableStartLine: 1,
              writableEndLine: 1,
              totalLines: 3,
            },
          });
          expect(input.relatedArtifactContexts).toEqual([
            {
              sourceExecutionId: "capability-execution-related",
              targetPath: "related.css",
              presentation: "full",
              content: ':root { --accent: "#0af"; }\n',
            },
          ]);
          expect(Object.isFrozen(input.relatedArtifactContexts)).toBe(true);
          expect(input.relatedArtifactContexts?.every(Object.isFrozen)).toBe(
            true,
          );
          return {
            status: "authored" as const,
            body: "after",
          };
        },
      );
      const validateCall = vi.fn(
        (call: { params: Record<string, unknown> }) => {
          try {
            const selection = JSON.parse(String(call.params.selection));
            return selection.placement === "replace"
              ? null
              : { error: "invalid selection" };
          } catch {
            return { error: "invalid selection JSON" };
          }
        },
      );
      const toolResult = executionResult({
        tool: "edit_file",
        output: "Edited target.txt.",
        data: { mutationEvidence: true },
      });
      const execute = vi.fn(async () => toolResult);
      const onEvent = vi.fn();
      const stagedOperation = operation({
        operationId: "edit_existing_file",
        summary: "Edit one existing file.",
        properties: {
          path: { type: "string", minLength: 1, maxLength: 4_096 },
          instruction: { type: "string", minLength: 1, maxLength: 4_096 },
          selection: { type: "string", minLength: 1, maxLength: 4_096 },
        },
        required: ["path", "instruction", "selection"],
        payload: {
          kind: "raw_text",
          param: "content",
          instructions: "Return raw edit content.",
          maxBytes: 1_024,
        },
        effect: "mutating",
      });
      const stagedRegistration: RegisteredToolNormalInvocation = {
        toolName: "edit_file",
        definition: {
          name: "edit_file",
          routingCapability: "filesystem_mutation",
          executionEffect: "mutating",
          params: {
            path: "string",
            instruction: "string",
            selection: "string",
            content: "string",
          },
          payloadChannelSpec: {
            params: ["selection", "content"],
            outputParam: "content",
            generationMode: "raw_text",
            targetParam: "path",
            targetRole: "operation_target",
            groundingWindow: 1,
            stages: [
              {
                outputParam: "selection",
                contextScope: "target_only",
                targetContext: "full_numbered",
                responseFormat: {
                  type: "object",
                  properties: {
                    placement: { type: "string" },
                    start_line: { type: "integer" },
                    end_line: { type: "integer" },
                  },
                  required: ["placement", "start_line", "end_line"],
                },
                targetLineBoundProperties: ["start_line", "end_line"],
                promptHint: "Return one exact location object.",
              },
              {
                outputParam: "content",
                contextScope: "target_with_artifacts",
                targetContext: "bounded",
                includeMaterializedParams: ["selection"],
                promptHint: "Return only raw replacement content.",
              },
            ],
          },
        },
        contract: { version: 1, operations: [stagedOperation] },
        adapter: { validateCall },
      };
      const provider =
        createRegisteredToolWorkerCapabilityProvider<TestContext>({
          getRequestToolRegistry: () =>
            createRegistry({
              registrations: [stagedRegistration],
              execute,
              prepareSharedState: (state = {}) => ({
                ...state,
                runtimePaths: {
                  rootDir: agentWorkDir,
                  agentWorkDir,
                },
              }),
            }),
          requestId: "request-staged-edit",
          sessionId: "session-staged-edit",
          abortSignal: new AbortController().signal,
          toolPermissionMode: "full_access",
          payloadAuthor: { author },
          nextApprovalId: () => "approval-unused",
          onEvent,
        });

      expect(provider.getDescriptors()[0]).toMatchObject({
        selectionControlIds: ["path"],
        controls: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", minLength: 1, maxLength: 4_096 },
            instruction: {
              type: "string",
              minLength: 1,
              maxLength: 4_096,
            },
          },
          required: ["path", "instruction"],
        },
      });
      await writeFile(
        join(agentWorkDir, "related.css"),
        ':root { --accent: "#0af"; }\n',
        "utf8",
      );
      const originalControls = Object.freeze({
        path: "target.txt",
        instruction: "Replace the first line.",
      });
      await expect(
        provider.getAdapters()[0]!.execute({
          context: { marker: "context-1" },
          call: resumedWorkerCall,
          executionId: "capability-execution-1",
          intent: "Replace the first line.",
          controls: originalControls,
          settledCapabilityResults,
        }),
      ).resolves.toEqual(
        withRegisteredExactResult(
          {
            outcome: "succeeded",
            observedEffect: "mutation",
            summary: "The mutation capability reported a completed change.",
            references: [{ kind: "tool_target", target: "Project/target.txt" }],
          },
          toolResult,
          [{ kind: "tool_target", target: "Project/target.txt" }],
        ),
      );
      expect(originalControls).toEqual({
        path: "target.txt",
        instruction: "Replace the first line.",
      });
      expect(Object.isFrozen(originalControls)).toBe(true);
      expect(author).toHaveBeenCalledTimes(2);
      expect(validateCall).toHaveBeenCalledTimes(2);
      expect(execute).toHaveBeenCalledExactlyOnceWith(
        {
          tool: "edit_file",
          params: {
            path: "Project/target.txt",
            instruction: "Replace the first line.",
            selection: '{"placement":"replace","start_line":1,"end_line":1}',
            content: "after",
          },
        },
        expect.any(Object),
      );
      expect(
        onEvent.mock.calls
          .filter(([name]) => name.startsWith("tool.payload."))
          .map(([name, payload]) => [
            name,
            payload.payloadStage,
            payload.payloadStageCount,
            payload.outputParam,
          ]),
      ).toEqual([
        ["tool.payload.started", 1, 2, "selection"],
        ["tool.payload.completed", 1, 2, "selection"],
        ["tool.payload.started", 2, 2, "content"],
        ["tool.payload.completed", 2, 2, "content"],
      ]);
      expect(
        (
          stagedRegistration.definition.payloadChannelSpec?.stages?.[0]
            ?.responseFormat as Record<string, Record<string, unknown>>
        ).properties,
      ).toEqual({
        placement: { type: "string" },
        start_line: { type: "integer" },
        end_line: { type: "integer" },
      });

      selectedLine = 4;
      await expect(
        provider.getAdapters()[0]!.execute({
          context: { marker: "context-2" },
          call: resumedWorkerCall,
          executionId: "capability-execution-2",
          intent: "Replace the first line.",
          controls: {
            path: "target.txt",
            instruction: "Replace the first line.",
          },
          settledCapabilityResults: [],
        }),
      ).resolves.toEqual(
        withRuntimeRejectionExactResult(
          {
            outcome: "failed",
            observedEffect: "none",
            summary: "The capability payload could not be prepared.",
            references: [{ kind: "tool_target", target: "Project/target.txt" }],
          },
          "payload_model_output_invalid",
          "The capability payload could not be prepared.",
          [{ kind: "tool_target", target: "Project/target.txt" }],
        ),
      );
      expect(author).toHaveBeenCalledTimes(3);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(onEvent).toHaveBeenLastCalledWith(
        "tool.payload.failed",
        expect.objectContaining({
          payloadStage: 1,
          error: "payload_model_output_invalid",
        }),
      );
    } finally {
      await rm(agentWorkDir, { recursive: true, force: true });
    }
  });

  test("carries one canonical observation from ledger through binding and adapter into payload author", async () => {
    const observationSummary =
      "System probe summary:\nmemory_used: 1.4 GiB / 29.4 GiB\ndisk_used: 175.9 GiB / 1006.9 GiB";
    const author = vi.fn<WorkerCapabilityPayloadAuthor["author"]>(async () => ({
      status: "authored" as const,
      body: "Grounded report body.\n",
    }));
    const observationToolResult = executionResult({
      tool: "system_probe",
      output: observationSummary,
      data: { currentStateEvidence: true },
    });
    const writerToolResult = executionResult({
      tool: "fake_writer",
      output: "Grounded artifact created.",
      data: { mutationEvidence: true },
    });
    const execute = vi.fn(async (call: { tool: string }) =>
      call.tool === "system_probe" ? observationToolResult : writerToolResult,
    );
    const provider = createRegisteredToolWorkerCapabilityProvider<TestContext>({
      getRequestToolRegistry: () =>
        createRegistry({
          registrations: [
            registration("system_probe", [operation()]),
            registration("fake_writer", [
              operation({
                operationId: "write_test_artifact",
                summary: "Write one complete grounded artifact.",
                properties: {
                  path: {
                    type: "string",
                    minLength: 1,
                    maxLength: 4_096,
                  },
                },
                required: ["path"],
                payload: {
                  kind: "raw_text",
                  param: "content",
                  instructions: "Return the complete grounded artifact body.",
                  maxBytes: 1_024,
                },
                effect: "mutating",
              }),
            ]),
          ],
          execute,
        }),
      requestId: "request-canonical-payload",
      sessionId: "session-canonical-payload",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      payloadAuthor: { author },
      nextApprovalId: () => "approval-unused",
    });
    const ledger = createRoleCallLedger({
      requestId: "request-canonical-payload",
      policy: {
        limits: {
          maxDepth: 4,
          maxCalls: 8,
          maxCapabilityExecutions: 8,
          maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
          maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
          maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
        },
      },
    });
    const commit = async (
      command: Parameters<RoleCallLedger["apply"]>[0]["command"],
    ) => {
      const result = await ledger.apply({
        expectedHead: ledger.current(),
        command,
      });
      if (!result.ok) throw new Error(result.code);
      return result.head;
    };
    await commit({ authority: "runtime", type: "create_root" });
    await commit({
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Inspect current state and write one grounded report.",
    });
    const firstCall = ledger
      .current()
      .state.calls.find(
        (candidate) => candidate.callId === ledger.current().state.activeCallId,
      );
    if (!firstCall) throw new Error("Worker call missing");
    const firstBinding = createWorkerCapabilityBinding({
      requestId: "request-canonical-payload",
      context: { marker: "context-1" },
      call: firstCall,
      ledger,
      adapters: provider.getAdapters(),
    });
    await firstBinding.execute({
      capabilityId: "inspect_system_state",
      intent: "Inspect the exact current state.",
      controls: {},
    });

    const resumedCall = ledger
      .current()
      .state.calls.find((candidate) => candidate.callId === firstCall.callId);
    if (!resumedCall) throw new Error("resumed Worker call missing");
    const secondBinding = createWorkerCapabilityBinding({
      requestId: "request-canonical-payload",
      context: { marker: "context-1" },
      call: resumedCall,
      ledger,
      adapters: provider.getAdapters(),
    });
    await secondBinding.execute({
      capabilityId: "write_test_artifact",
      intent: "Write the observed values into the report.",
      controls: { path: "project/report.md" },
    });

    expect(author).toHaveBeenCalledOnce();
    const payloadInput = author.mock.calls[0]![0];
    expect(payloadInput.executionId).toBe("capability-execution-2");
    expect(payloadInput).not.toHaveProperty("requestSteering");
    expect(payloadInput.settledCapabilityResults).toEqual([
      {
        executionId: "capability-execution-1",
        callId: firstCall.callId,
        invocationAttempt: 1,
        capabilityId: "inspect_system_state",
        declaredEffect: "observation",
        outcome: "succeeded",
        observedEffect: "observation",
        summary: observationSummary,
        adapterResult: {
          kind: "registered_tool_execution_result_v1",
          authority: "registered_plugin",
          status: "executed",
          result: observationToolResult,
        },
      },
    ]);
    expect(Object.isFrozen(payloadInput.settledCapabilityResults)).toBe(true);
    expect(payloadInput.settledCapabilityResults.every(Object.isFrozen)).toBe(
      true,
    );
    expect(execute).toHaveBeenCalledTimes(2);
    expect(ledger.current().state.capabilityExecutions).toEqual([
      expect.objectContaining({
        executionId: "capability-execution-1",
        summary: observationSummary,
      }),
      expect.objectContaining({
        executionId: "capability-execution-2",
        capabilityId: "write_test_artifact",
        outcome: "succeeded",
      }),
    ]);
  });

  test("reports a fake payload-author failure without executing the tool", async () => {
    const execute = vi.fn();
    const onEvent = vi.fn();
    const provider = createRegisteredToolWorkerCapabilityProvider<TestContext>({
      getRequestToolRegistry: () =>
        createRegistry({
          registrations: [
            registration("fake_writer", [
              operation({
                operationId: "write_test_artifact",
                summary: "Write one complete test artifact.",
                payload: {
                  kind: "raw_text",
                  param: "content",
                  instructions: "Return the complete artifact body.",
                  maxBytes: 1_024,
                },
                effect: "mutating",
              }),
            ]),
          ],
          execute,
        }),
      requestId: "request-failed-payload",
      sessionId: "session-failed-payload",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      payloadAuthor: {
        author: vi.fn(async () =>
          Object.freeze({
            status: "failed" as const,
            code: "payload_context_budget_exceeded" as const,
          }),
        ),
      },
      nextApprovalId: () => "approval-unused",
      onEvent,
    });

    await expect(
      provider.getAdapters()[0]!.execute({
        context: { marker: "context-1" },
        call: WORKER_CALL,
        executionId: "capability-execution-1",
        intent: "Create the requested test artifact.",
        controls: {},
        settledCapabilityResults: [],
      }),
    ).resolves.toEqual(
      withRuntimeRejectionExactResult(
        {
          outcome: "failed",
          observedEffect: "none",
          summary: "The capability payload could not be prepared.",
        },
        "payload_context_budget_exceeded",
        "The capability payload could not be prepared.",
      ),
    );
    expect(execute).not.toHaveBeenCalled();
    expect(onEvent.mock.calls.map(([name]) => name)).toEqual([
      "tool.payload.started",
      "tool.payload.failed",
    ]);
  });

  test.each([
    {
      label: "an exhausted undersized payload",
      authorResult: Object.freeze({
        status: "failed" as const,
        code: "payload_body_too_small" as const,
      }),
    },
    {
      label: "an empty success reported by a nonconforming custom author",
      authorResult: Object.freeze({
        status: "authored" as const,
        body: "",
      }),
    },
  ])(
    "blocks $label before the registered tool boundary",
    async ({ authorResult }) => {
      const execute = vi.fn();
      const onEvent = vi.fn();
      const author = vi.fn<WorkerCapabilityPayloadAuthor["author"]>(
        async (input) => {
          expect(input.contract).toEqual({
            instructions: "Return the complete artifact body.",
            minBytes: 1,
            maxBytes: 1_024,
          });
          return authorResult;
        },
      );
      const provider =
        createRegisteredToolWorkerCapabilityProvider<TestContext>({
          getRequestToolRegistry: () =>
            createRegistry({
              registrations: [
                registration("minimum_writer", [
                  operation({
                    operationId: "write_nonempty_artifact",
                    summary: "Write one non-empty artifact.",
                    payload: {
                      kind: "raw_text",
                      param: "content",
                      instructions: "Return the complete artifact body.",
                      minBytes: 1,
                      maxBytes: 1_024,
                    },
                    effect: "mutating",
                  }),
                ]),
              ],
              execute,
            }),
          requestId: "request-minimum-payload-rejected",
          sessionId: "session-minimum-payload-rejected",
          abortSignal: new AbortController().signal,
          toolPermissionMode: "full_access",
          payloadAuthor: { author },
          nextApprovalId: () => "approval-unused",
          onEvent,
        });

      await expect(
        provider.getAdapters()[0]!.execute({
          context: { marker: "context-1" },
          call: WORKER_CALL,
          executionId: "capability-execution-1",
          intent: "Create the requested non-empty artifact.",
          controls: {},
          settledCapabilityResults: [],
        }),
      ).resolves.toEqual(
        withRuntimeRejectionExactResult(
          {
            outcome: "failed",
            observedEffect: "none",
            summary: "The capability payload could not be prepared.",
          },
          "payload_body_too_small",
          "The capability payload could not be prepared.",
        ),
      );
      expect(author).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
      expect(onEvent.mock.calls.map(([name]) => name)).toEqual([
        "tool.payload.started",
        "tool.payload.failed",
      ]);
      expect(onEvent.mock.calls.at(-1)?.[1]).toMatchObject({
        error: "payload_body_too_small",
      });
    },
  );

  test("does not invoke a configured payload author for an operation without a payload", async () => {
    const author = vi.fn<WorkerCapabilityPayloadAuthor["author"]>();
    const provider = createRegisteredToolWorkerCapabilityProvider<TestContext>({
      getRequestToolRegistry: () =>
        createRegistry({
          registrations: [registration("system_probe", [operation()])],
          execute: vi.fn(async () => executionResult()),
        }),
      requestId: "request-no-payload",
      sessionId: "session-no-payload",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      payloadAuthor: { author },
      nextApprovalId: () => "approval-unused",
    });

    await provider.getAdapters()[0]!.execute({
      context: { marker: "context-1" },
      call: WORKER_CALL,
      executionId: "capability-execution-1",
      intent: "Inspect the current system.",
      controls: {},
      settledCapabilityResults: [],
    });
    expect(author).not.toHaveBeenCalled();
  });

  test("reuses the ordinary executor as the sole approval and tool-event owner", async () => {
    const execute = vi.fn(async () => executionResult());
    const requestToolApproval = vi.fn(async () => ({ approved: true }));
    const nextApprovalId = vi.fn(() => "approval-1");
    const onEvent = vi.fn();
    const provider = createRegisteredToolWorkerCapabilityProvider<TestContext>({
      getRequestToolRegistry: () =>
        createRegistry({
          registrations: [
            registration("system_probe", [operation({ approval: "always" })]),
          ],
          execute,
        }),
      requestId: "request-approval",
      sessionId: "session-approval",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      toolApprovalController: { requestToolApproval },
      nextApprovalId,
      onEvent,
    });

    await provider.getAdapters()[0]!.execute({
      context: { marker: "context-1" },
      call: WORKER_CALL,
      executionId: "capability-execution-1",
      intent: "Inspect the current system.",
      controls: {},
      settledCapabilityResults: [],
    });

    expect(nextApprovalId).toHaveBeenCalledOnce();
    expect(requestToolApproval).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(onEvent.mock.calls.map(([name]) => name)).toEqual([
      "tool.approval.required",
      "tool.approval.granted",
      "tool.started",
      "tool.completed",
    ]);
  });

  test.each([
    {
      label: "without current-state evidence",
      data: undefined,
      observedEffect: "none",
    },
    {
      label: "with current-state evidence",
      data: { currentStateEvidence: true },
      observedEffect: "observation",
    },
  ])("maps an executed failure $label", async ({ data, observedEffect }) => {
    const toolResult = executionResult({
      ok: false,
      output: "Partial state.",
      producedNewInformation: data !== undefined,
      error: "System inspection failed.",
      errorCode: "system_probe_failed",
      ...(data ? { data } : {}),
    });
    const provider = createRegisteredToolWorkerCapabilityProvider<TestContext>({
      getRequestToolRegistry: () =>
        createRegistry({
          registrations: [registration("system_probe", [operation()])],
          execute: vi.fn(async () => toolResult),
        }),
      requestId: "request-failure",
      sessionId: "session-failure",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      nextApprovalId: () => "approval-unused",
    });

    await expect(
      provider.getAdapters()[0]!.execute({
        context: { marker: "context-1" },
        call: WORKER_CALL,
        executionId: "capability-execution-1",
        intent: "Inspect the current system.",
        controls: {},
        settledCapabilityResults: [],
      }),
    ).resolves.toEqual(
      withRegisteredExactResult(
        {
          outcome: "failed",
          observedEffect,
          summary: "System inspection failed.",
        },
        toolResult,
      ),
    );
  });

  test("does not invent observation evidence for a successful tool result with empty output", async () => {
    const toolResult = executionResult({ output: "   " });
    const provider = createRegisteredToolWorkerCapabilityProvider<TestContext>({
      getRequestToolRegistry: () =>
        createRegistry({
          registrations: [registration("system_probe", [operation()])],
          execute: vi.fn(async () => toolResult),
        }),
      requestId: "request-empty-output",
      sessionId: "session-empty-output",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      nextApprovalId: () => "approval-unused",
    });

    await expect(
      provider.getAdapters()[0]!.execute({
        context: { marker: "context-1" },
        call: WORKER_CALL,
        executionId: "capability-execution-1",
        intent: "Inspect the current system.",
        controls: {},
        settledCapabilityResults: [],
      }),
    ).resolves.toEqual(
      withRegisteredExactResult(
        {
          outcome: "failed",
          observedEffect: "none",
          summary: "The observation capability returned no usable result.",
        },
        toolResult,
      ),
    );
  });

  test("does not invent target references from generic completion actions", async () => {
    const toolResult = executionResult({
      tool: "dev_view",
      output: "Current file body.",
      actions: [{ type: "inspect_target", target: "project/app.js" }],
    });
    const provider = createRegisteredToolWorkerCapabilityProvider<TestContext>({
      getRequestToolRegistry: () =>
        createRegistry({
          registrations: [
            registration("dev_view", [
              operation({
                operationId: "inspect_target",
                properties: {
                  path: { type: "string", minLength: 1, maxLength: 4_096 },
                },
                required: ["path"],
              }),
            ]),
          ],
          execute: vi.fn(async () => toolResult),
        }),
      requestId: "request-observation-target",
      sessionId: "session-observation-target",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      nextApprovalId: () => "approval-unused",
    });

    await expect(
      provider.getAdapters()[0]!.execute({
        context: { marker: "context-1" },
        call: WORKER_CALL,
        executionId: "capability-execution-1",
        intent: "Inspect the current file.",
        controls: { path: "project/app.js" },
        settledCapabilityResults: [],
      }),
    ).resolves.toEqual(
      withRegisteredExactResult(
        {
          outcome: "succeeded",
          observedEffect: "observation",
          summary: "Current file body.",
        },
        toolResult,
      ),
    );
  });

  test("prevents normalization from escaping the configured operation snapshot", async () => {
    configureDebugLogger({ enabled: true });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const execute = vi.fn();
    const provider = createRegisteredToolWorkerCapabilityProvider<TestContext>({
      getRequestToolRegistry: () =>
        createRegistry({
          registrations: [
            registration("source_probe", [operation()], {
              normalizeCall: () => ({
                tool: "unselected_probe",
                params: {},
              }),
            }),
          ],
          execute,
        }),
      requestId: "request-narrow",
      sessionId: "session-narrow",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      nextApprovalId: () => "approval-unused",
    });

    await expect(
      provider.getAdapters()[0]!.execute({
        context: { marker: "context-1" },
        call: WORKER_CALL,
        executionId: "capability-execution-1",
        intent: "Inspect only the configured state.",
        controls: {},
        settledCapabilityResults: [],
      }),
    ).resolves.toEqual(
      withRuntimeRejectionExactResult(
        {
          outcome: "failed",
          observedEffect: "none",
          summary:
            "The normalized tool is not enabled in the selected request profile.",
        },
        "normal_invocation_target_unavailable",
        "The normalized tool is not enabled in the selected request profile.",
      ),
    );
    expect(execute).not.toHaveBeenCalled();
    expect(
      consoleLog.mock.calls
        .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
        .filter(
          (entry) =>
            entry.scope === "runtime.registered_tool_worker_capabilities",
        ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "adapter.execution_completed",
          sourceStatus: "rejected",
          sourceIssueCode: "normal_invocation_target_unavailable",
          outcome: "failed",
          observedEffect: "none",
        }),
      ]),
    );
  });

  test.each([
    {
      label: "ambiguous operation",
      registrations: [
        registration("system_probe_a", [operation()]),
        registration("system_probe_b", [operation()]),
      ],
      issueCode: "operation_ambiguous",
    },
    {
      label: "raw payload",
      registrations: [
        registration("system_probe", [
          operation({
            payload: {
              kind: "raw_text",
              param: "body",
              instructions: "Provide the body.",
              maxBytes: 1_024,
            },
          }),
        ]),
      ],
      issueCode: "operation_payload_author_unavailable",
    },
  ])(
    "rejects $label during exact composition and memoizes the failure",
    ({ registrations, issueCode }) => {
      const getRequestToolRegistry = vi.fn(() =>
        createRegistry({
          registrations,
          execute: vi.fn(),
        }),
      );
      const provider =
        createRegisteredToolWorkerCapabilityProvider<TestContext>({
          getRequestToolRegistry,
          requestId: "request-rejection",
          sessionId: "session-rejection",
          abortSignal: new AbortController().signal,
          toolPermissionMode: "full_access",
          nextApprovalId: () => "approval-unused",
        });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(() => provider.getAdapters()).toThrow(issueCode);
      }
      expect(getRequestToolRegistry).toHaveBeenCalledOnce();
    },
  );

  test("rejects an unsafe registered capability identity after registry loading", () => {
    configureDebugLogger({ enabled: true });
    const unsafeOperationId = `Unsafe-${"SECRET".repeat(100)}`;
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const getRequestToolRegistry = vi.fn(() =>
      createRegistry({
        registrations: [
          registration("unsafe_probe", [
            operation({ operationId: unsafeOperationId }),
          ]),
        ],
        execute: vi.fn(),
      }),
    );

    expect(() =>
      createRegisteredToolWorkerCapabilityProvider<TestContext>({
        getRequestToolRegistry,
        requestId: "request-unsafe-selection",
        sessionId: "session-unsafe-selection",
        abortSignal: new AbortController().signal,
        toolPermissionMode: "full_access",
        nextApprovalId: () => "approval-unused",
      }).getAdapters(),
    ).toThrow("capability_id_unsupported");
    expect(getRequestToolRegistry).toHaveBeenCalledOnce();
    expect(JSON.stringify(consoleLog.mock.calls)).not.toContain(
      unsafeOperationId,
    );
  });

  test("memoizes a stable provider failure without exposing registry error text", () => {
    configureDebugLogger({ enabled: true });
    const errorSecret = "REGISTRY_ERROR_SECRET_MUST_NOT_ESCAPE";
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const getRequestToolRegistry = vi.fn(() => {
      throw new Error(errorSecret);
    });
    const provider = createRegisteredToolWorkerCapabilityProvider<TestContext>({
      getRequestToolRegistry,
      requestId: "request-provider-failure",
      sessionId: "session-provider-failure",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      nextApprovalId: () => "approval-unused",
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(() => provider.getAdapters()).toThrow(
        "registered_tool_worker_capability_provider:resolution_failed",
      );
      try {
        provider.getAdapters();
      } catch (error: unknown) {
        expect(
          error instanceof Error ? error.message : String(error),
        ).not.toContain(errorSecret);
      }
    }
    expect(getRequestToolRegistry).toHaveBeenCalledOnce();
    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.registered_tool_worker_capabilities",
          event: "provider.resolution_rejected",
          issueCode: "resolution_failed",
          errorType: "Error",
        }),
      ]),
    );
    expect(JSON.stringify(logs)).not.toContain(errorSecret);
  });

  test("rejects malformed tool results at the adapter protocol boundary", async () => {
    configureDebugLogger({ enabled: true });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const provider = createRegisteredToolWorkerCapabilityProvider<TestContext>({
      getRequestToolRegistry: () =>
        createRegistry({
          registrations: [registration("system_probe", [operation()])],
          execute: vi.fn(async () => ({
            ...executionResult(),
            producedNewInformation: "yes",
          })) as unknown as ToolRegistry["execute"],
        }),
      requestId: "request-malformed",
      sessionId: "session-malformed",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      nextApprovalId: () => "approval-unused",
    });

    await expect(
      provider.getAdapters()[0]!.execute({
        context: { marker: "context-1" },
        call: WORKER_CALL,
        executionId: "capability-execution-1",
        intent: "Inspect the current system.",
        controls: {},
        settledCapabilityResults: [],
      }),
    ).rejects.toThrow(
      "registered_tool_worker_capability_execution:tool_result_invalid",
    );
    expect(
      consoleLog.mock.calls
        .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
        .filter(
          (entry) =>
            entry.scope === "runtime.registered_tool_worker_capabilities",
        ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "adapter.execution_failed",
          protocolIssueCode: "tool_result_invalid",
          errorType: "TypeError",
        }),
      ]),
    );
  });

  test("preserves oversized observation output as complete reference data", async () => {
    const oversizedOutput = "x".repeat(ROLE_CALL_RESULT_MAX_LENGTH + 1);
    const toolResult = executionResult({ output: oversizedOutput });
    const provider = createRegisteredToolWorkerCapabilityProvider<TestContext>({
      getRequestToolRegistry: () =>
        createRegistry({
          registrations: [registration("system_probe", [operation()])],
          execute: vi.fn(async () => toolResult),
        }),
      requestId: "request-reference-output",
      sessionId: "session-reference-output",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      nextApprovalId: () => "approval-unused",
    });

    await expect(
      provider.getAdapters()[0]!.execute({
        context: { marker: "context-1" },
        call: WORKER_CALL,
        executionId: "capability-execution-1",
        intent: "Inspect the current system.",
        controls: {},
        settledCapabilityResults: [],
      }),
    ).resolves.toEqual(
      withRegisteredExactResult(
        {
          outcome: "succeeded",
          observedEffect: "observation",
          summary: expect.stringContaining(
            `${oversizedOutput.length} characters of result data`,
          ),
          referenceData: oversizedOutput,
        },
        toolResult,
      ),
    );
  });

  test("preserves direct-root plugin output beyond the legacy reference-data limit", async () => {
    const exactOutput = `  ${"x".repeat(
      ROLE_CAPABILITY_REFERENCE_DATA_MAX_LENGTH + 1,
    )}\n`;
    const toolResult = executionResult({ output: exactOutput });
    const provider = createRegisteredToolWorkerCapabilityProvider<TestContext>({
      getRequestToolRegistry: () =>
        createRegistry({
          registrations: [registration("system_probe", [operation()])],
          execute: vi.fn(async () => toolResult),
        }),
      requestId: "request-direct-exact-output",
      sessionId: "session-direct-exact-output",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      nextApprovalId: () => "approval-unused",
    });

    await expect(
      provider.getAdapters()[0]!.execute({
        context: { marker: "context-1" },
        call: ROOT_CALL,
        executionId: "capability-execution-1",
        intent: "Inspect the complete current system result.",
        controls: {},
        settledCapabilityResults: [],
      }),
    ).resolves.toEqual({
      outcome: "succeeded",
      observedEffect: "observation",
      summary:
        "The capability result is available in the canonical direct execution result.",
      exactResult: {
        kind: "registered_tool_execution_result_v1",
        authority: "registered_plugin",
        status: "executed",
        result: toolResult,
      },
    });
  });

  test("preserves an exact direct-root plugin failure without normalizing its strings", async () => {
    const toolResult = executionResult({
      ok: false,
      output: "  raw failure output\n",
      error: "\texact plugin failure  ",
      errorCode: "tool_failed",
    });
    const provider = createRegisteredToolWorkerCapabilityProvider<TestContext>({
      getRequestToolRegistry: () =>
        createRegistry({
          registrations: [registration("system_probe", [operation()])],
          execute: vi.fn(async () => toolResult),
        }),
      requestId: "request-direct-exact-failure",
      sessionId: "session-direct-exact-failure",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      nextApprovalId: () => "approval-unused",
    });

    await expect(
      provider.getAdapters()[0]!.execute({
        context: { marker: "context-1" },
        call: ROOT_CALL,
        executionId: "capability-execution-1",
        intent: "Inspect the exact failure.",
        controls: {},
        settledCapabilityResults: [],
      }),
    ).resolves.toEqual({
      outcome: "failed",
      observedEffect: "none",
      summary: "exact plugin failure",
      exactResult: {
        kind: "registered_tool_execution_result_v1",
        authority: "registered_plugin",
        status: "executed",
        result: toolResult,
      },
    });
  });

  test("preserves observation output beyond the legacy reference-data limit in the exact result", async () => {
    configureDebugLogger({ enabled: true });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const oversizedOutput = "x".repeat(
      ROLE_CAPABILITY_REFERENCE_DATA_MAX_LENGTH + 1,
    );
    const toolResult = executionResult({ output: oversizedOutput });
    const provider = createRegisteredToolWorkerCapabilityProvider<TestContext>({
      getRequestToolRegistry: () =>
        createRegistry({
          registrations: [registration("system_probe", [operation()])],
          execute: vi.fn(async () => toolResult),
        }),
      requestId: "request-oversized-output",
      sessionId: "session-oversized-output",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      nextApprovalId: () => "approval-unused",
    });

    await expect(
      provider.getAdapters()[0]!.execute({
        context: { marker: "context-1" },
        call: WORKER_CALL,
        executionId: "capability-execution-1",
        intent: "Inspect the current system.",
        controls: {},
        settledCapabilityResults: [],
      }),
    ).resolves.toEqual(
      withRegisteredExactResult(
        {
          outcome: "succeeded",
          observedEffect: "observation",
          summary:
            "The capability result is available in the canonical execution result.",
        },
        toolResult,
      ),
    );
    expect(
      consoleLog.mock.calls
        .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
        .filter(
          (entry) =>
            entry.scope === "runtime.registered_tool_worker_capabilities",
        ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "adapter.execution_completed",
          sourceStatus: "executed",
          outcome: "succeeded",
          observedEffect: "observation",
          summaryProjection: "bounded_external_result",
        }),
      ]),
    );
  });

  test("logs correlation and outcomes without intent, output, controls or error text", async () => {
    configureDebugLogger({ enabled: true });
    const intentSecret = "INTENT_SECRET_MUST_NOT_BE_LOGGED";
    const outputSecret = "OUTPUT_SECRET_MUST_NOT_BE_LOGGED";
    const errorSecret = "ERROR_SECRET_MUST_NOT_BE_LOGGED";
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const successProvider =
      createRegisteredToolWorkerCapabilityProvider<TestContext>({
        getRequestToolRegistry: () =>
          createRegistry({
            registrations: [registration("system_probe", [operation()])],
            execute: vi.fn(async () =>
              executionResult({ output: outputSecret }),
            ),
          }),
        requestId: "request-logging",
        sessionId: "session-logging",
        abortSignal: new AbortController().signal,
        toolPermissionMode: "full_access",
        nextApprovalId: () => "approval-unused",
      });
    await successProvider.getAdapters()[0]!.execute({
      context: { marker: "context-1" },
      call: WORKER_CALL,
      executionId: "capability-execution-1",
      intent: intentSecret,
      controls: {},
      settledCapabilityResults: [],
    });

    const failureProvider =
      createRegisteredToolWorkerCapabilityProvider<TestContext>({
        getRequestToolRegistry: () =>
          createRegistry({
            registrations: [registration("system_probe", [operation()])],
            execute: vi.fn(async () => {
              throw new Error(errorSecret);
            }),
          }),
        requestId: "request-logging-failure",
        sessionId: "session-logging",
        abortSignal: new AbortController().signal,
        toolPermissionMode: "full_access",
        nextApprovalId: () => "approval-unused",
      });
    await expect(
      failureProvider.getAdapters()[0]!.execute({
        context: { marker: "context-1" },
        call: WORKER_CALL,
        executionId: "capability-execution-1",
        intent: intentSecret,
        controls: {},
        settledCapabilityResults: [],
      }),
    ).rejects.toThrow(errorSecret);

    const logs = consoleLog.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter(
        (entry) =>
          entry.scope === "runtime.registered_tool_worker_capabilities",
      );
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "provider.catalog_resolution_completed",
          requestId: "request-logging",
          configuredOperationCount: 1,
          descriptorCount: 1,
        }),
        expect.objectContaining({
          event: "provider.resolution_completed",
          requestId: "request-logging",
          configuredOperationCount: 1,
          adapterCount: 1,
        }),
        expect.objectContaining({
          event: "adapter.execution_started",
          requestId: "request-logging",
          operationId: "inspect_system_state",
          callId: WORKER_CALL.callId,
          invocationAttempt: 1,
          intentLength: intentSecret.length,
        }),
        expect.objectContaining({
          event: "adapter.execution_completed",
          sourceStatus: "executed",
          outcome: "succeeded",
          observedEffect: "observation",
          summaryLength: outputSecret.length,
          summaryProjection: "bounded_external_result",
          completionActionCount: 0,
          completionActionTypes: [],
          logicalTargetCount: 0,
          logicalTargetLengths: [],
        }),
        expect.objectContaining({
          event: "adapter.execution_failed",
          requestId: "request-logging-failure",
          errorType: "Error",
        }),
      ]),
    );
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(intentSecret);
    expect(serialized).not.toContain(outputSecret);
    expect(serialized).not.toContain(errorSecret);
  });
});

function createRegistry(
  params: Readonly<{
    registrations: readonly RegisteredToolNormalInvocation[];
    execute: ToolRegistry["execute"];
    prepareSharedState?: ToolRegistry["prepareSharedState"];
  }>,
): ToolRegistry {
  const definitions = params.registrations.map(
    (registration) => registration.definition,
  );
  return {
    listDefinitions: () => definitions,
    listNormalInvocations: () => params.registrations,
    getDefinition: (name) =>
      definitions.find((definition) => definition.name === name),
    hasToolsAvailable: () => definitions.length > 0,
    getImplementations: () => ({}),
    ...(params.prepareSharedState
      ? { prepareSharedState: params.prepareSharedState }
      : {}),
    execute: params.execute,
  };
}

function registration(
  toolName: string,
  operations: readonly ToolNormalInvocationOperation[],
  adapter?: ToolCallAdapter,
  catalogGroups?: readonly string[],
): RegisteredToolNormalInvocation {
  const params = Object.fromEntries(
    operations.flatMap((candidate) => [
      ...Object.entries(candidate.input.properties).map(([name, schema]) => [
        name,
        schema.type === "array"
          ? `${schema.items.type}[]`
          : schema.type === "integer"
            ? "integer"
            : schema.type,
      ]),
      ...Object.entries(candidate.fixedParams ?? {}).map(([name, value]) => [
        name,
        typeof value === "number" && Number.isSafeInteger(value)
          ? "integer"
          : typeof value,
      ]),
      ...(candidate.payload ? [[candidate.payload.param, "string"]] : []),
    ]),
  );
  const effects = new Set(operations.map((candidate) => candidate.effect));
  const executionEffect: ToolNormalInvocationEffect =
    effects.size === 1 ? operations[0]!.effect : "mixed";
  return {
    toolName,
    definition: {
      name: toolName,
      routingCapability: "filesystem_inspection",
      executionEffect,
      ...(catalogGroups ? { catalogGroups: [...catalogGroups] } : {}),
      params,
    },
    contract: {
      version: 1,
      operations,
    },
    ...(adapter ? { adapter } : {}),
  };
}

function targetAwareRegistration(
  toolName: string,
  operationId: string,
  targetRole: "operation_target" | "payload_body" | undefined,
): RegisteredToolNormalInvocation {
  const writeOperation = operation({
    operationId,
    summary: `Write through ${toolName}.`,
    properties: {
      path: { type: "string", minLength: 1, maxLength: 4_096 },
    },
    required: ["path"],
    payload: {
      kind: "raw_text",
      param: "content",
      instructions: "Return the complete body.",
      maxBytes: 1_024,
    },
    effect: "mutating",
  });
  const base = registration(toolName, [writeOperation]);
  return {
    ...base,
    definition: {
      ...base.definition,
      payloadChannelSpec: {
        params: ["content"],
        outputParam: "content",
        generationMode: "raw_text",
        targetParam: "path",
        ...(targetRole ? { targetRole } : {}),
      },
    },
  };
}

function conditionalStagedPayloadRegistration(): RegisteredToolNormalInvocation {
  const editOperation = operation({
    operationId: "edit_conditional_content",
    summary: "Apply one staged conditional edit.",
    properties: {
      instruction: { type: "string", minLength: 1, maxLength: 4_096 },
      selection: { type: "string", minLength: 1, maxLength: 4_096 },
    },
    required: ["instruction", "selection"],
    payload: {
      kind: "raw_text",
      param: "content",
      instructions: "Return the raw edit content.",
      maxBytes: 1_024,
    },
    effect: "mutating",
  });
  return {
    toolName: "conditional_editor",
    definition: {
      name: "conditional_editor",
      routingCapability: "filesystem_mutation",
      executionEffect: "mutating",
      params: {
        instruction: "string",
        selection: "string",
        content: "string",
      },
      payloadChannelSpec: {
        params: ["selection", "content"],
        outputParam: "content",
        generationMode: "raw_text",
        stages: [
          {
            outputParam: "selection",
            responseFormat: {
              type: "object",
              properties: {
                placement: {
                  type: "string",
                  enum: ["before", "after", "replace", "delete"],
                },
              },
              required: ["placement"],
              additionalProperties: false,
            },
            promptHint: "Return one placement object.",
          },
          {
            outputParam: "content",
            includeMaterializedParams: ["selection"],
            minBytes: 1,
            literalOutput: {
              when: {
                materializedParam: "selection",
                property: "placement",
                equals: "delete",
              },
              value: "",
            },
            promptHint: "Return only raw edit content.",
          },
        ],
      },
    },
    contract: { version: 1, operations: [editOperation] },
  };
}

function runtimePathRegistration(
  toolName: string,
  runtimeOperation: ToolNormalInvocationOperation,
  runtimePathBindings: NonNullable<
    RegisteredToolNormalInvocation["definition"]["runtimePathBindings"]
  >,
): RegisteredToolNormalInvocation {
  const base = registration(toolName, [runtimeOperation]);
  return {
    ...base,
    definition: {
      ...base.definition,
      runtimePathBindings: [...runtimePathBindings],
    },
  };
}

function operation(
  overrides: Partial<ToolNormalInvocationOperation> & {
    properties?: ToolNormalInvocationOperation["input"]["properties"];
    required?: readonly string[];
  } = {},
): ToolNormalInvocationOperation {
  const {
    properties = {},
    required = [],
    input: _ignoredInput,
    ...rest
  } = overrides;
  void _ignoredInput;
  return {
    operationId: "inspect_system_state",
    summary: "Inspect current system state.",
    input: {
      type: "object",
      additionalProperties: false,
      properties,
      required,
    },
    effect: "read_only",
    approval: "request_policy",
    ...rest,
  };
}

function executionResult(
  overrides: Partial<ToolExecutionResult> = {},
): ToolExecutionResult {
  return {
    ok: true,
    tool: "system_probe",
    output: "Current system state.",
    producedNewInformation: true,
    ...overrides,
  };
}

function withRegisteredExactResult<T extends Record<string, unknown>>(
  result: T,
  toolResult: ToolExecutionResult,
  references?: readonly Readonly<{ kind: "tool_target"; target: string }>[],
) {
  return {
    ...result,
    exactResult: {
      kind: "registered_tool_execution_result_v1" as const,
      authority: "registered_plugin" as const,
      status: "executed" as const,
      result: toolResult,
      ...(references ? { references } : {}),
    },
  };
}

function withRuntimeRejectionExactResult<T extends Record<string, unknown>>(
  result: T,
  code: string,
  message: string,
  references?: readonly Readonly<{ kind: "tool_target"; target: string }>[],
) {
  return {
    ...result,
    exactResult: {
      kind: "runtime_capability_rejection_v1" as const,
      authority: "runtime" as const,
      status: "rejected" as const,
      stage: "before_external_execution" as const,
      code,
      message,
      ...(references ? { references } : {}),
    },
  };
}
