import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { vi } from "vitest";
import createExecPlugin from "../../../../plugins/exec/source/index.js";
import type { ToolModuleDeclaration } from "../../../capabilities/tool-types.js";
import {
  successResult,
  type RuntimePluginEntrypoint,
} from "../../../plugin-sdk/index.js";
import { createConfiguredToolRegistry } from "../../capabilities/configured-tool-registry.js";
import { createRuntimeToolPathResolver } from "../../capabilities/runtime-target-path.js";
import {
  loadConfiguredRuntimePlugins,
  runtimePluginsToToolModules,
} from "../../plugins/loader.js";
import type {
  ToolApprovalController,
  ToolPermissionMode,
} from "../../ports.js";
import type { RequestExecutionSeed } from "../../request/contracts.js";
import { resolveRequestExecutionPolicy } from "../../request/role-executor-composition.js";
import { runRequestRunner } from "../../request/runner.js";
import { createRequestWorkerCapabilityProvider } from "../../request/worker-capability-composition.js";
import type { ExecRequestPolicy } from "./exec-command-request-script.js";
import { createTestRequestExecutionScopeWithCapabilities } from "./request-execution-scope.js";
import { createRuntimeConfig } from "./runtime-composition-fixture.js";
import {
  createExecApprovalScript,
  type ApprovalScriptAction,
} from "./exec-sensitive-approval-script.js";

export const EXEC_APPROVAL_COMMANDS = [
  "printf first > first.txt",
  "printf second > second.txt",
] as const;

export async function createExecApprovalFixture(disabled = false) {
  const config = await createRuntimeConfig();
  await mkdir(config.paths.agentWorkDir, { recursive: true });
  await writeFile(
    join(config.paths.agentWorkDir, "ordinary.txt"),
    "ordinary observation",
  );
  const loaded = loadConfiguredRuntimePlugins({
    ...config,
    plugins: { allow: ["exec"], deny: disabled ? ["exec"] : [] },
  });
  const pluginRoot = join(process.cwd(), "plugins", "exec");
  const plugin: RuntimePluginEntrypoint | undefined = disabled
    ? undefined
    : createExecPlugin({
        id: "exec",
        path: join(pluginRoot, "plugin.json"),
        pluginRoot,
        stateDir: join(config.paths.runtimeDir, "plugins", "exec"),
        rootDir: config.paths.rootDir,
        runtimeId: "exec-approval-fixture",
        agentBridgeUrl: "ws://unused",
        runtimePaths: config.paths,
        runtimePathResolver: createRuntimeToolPathResolver(config.paths),
        config: { timeoutMs: 5000, yieldAfterMs: 5000 },
      });
  const execute = vi.fn(plugin?.handlers.exec);
  const execModules = runtimePluginsToToolModules(loaded).map((module) => {
    const implementation = plugin?.handlers[module.definition.name];
    if (!implementation) {
      throw new Error(
        `Missing source fixture handler: ${module.definition.name}`,
      );
    }
    return {
      ...module,
      implementation:
        module.definition.name === "exec" ? execute : implementation,
      adapter: plugin?.adapters?.[module.definition.name],
    };
  });
  const ordinaryRead = vi.fn(async () =>
    successResult({
      output: await readFile(
        join(config.paths.agentWorkDir, "ordinary.txt"),
        "utf8",
      ),
    }),
  );
  const ordinaryModule: ToolModuleDeclaration = {
    definition: {
      name: "approval_fixture_read",
      routingCapability: "semantic_lookup",
      catalogGroups: ["approval_fixture"],
    },
    normalInvocation: {
      version: 1,
      operations: [
        {
          operationId: "read_approval_fixture",
          summary: "Observe one harmless fixture record.",
          effect: "read_only",
          approval: "request_policy",
          input: {
            type: "object",
            additionalProperties: false,
            properties: {},
            required: [],
          },
        },
      ],
    },
    implementation: ordinaryRead,
  };
  const registry = createConfiguredToolRegistry(config, [
    ...execModules,
    ordinaryModule,
  ]);
  const controller = new AbortController();
  const onEvent = vi.fn();
  const onAnswerToken = vi.fn();
  return {
    config,
    registry,
    execute,
    ordinaryRead,
    controller,
    onEvent,
    onAnswerToken,
    start(options: {
      policy: ExecRequestPolicy;
      mode: ToolPermissionMode;
      approval?: ToolApprovalController;
      commandCount?: number;
      ordinary?: boolean;
    }) {
      const actions: readonly ApprovalScriptAction[] = options.ordinary
        ? [{ capabilityId: "read_approval_fixture", controls: {} }]
        : EXEC_APPROVAL_COMMANDS.slice(0, options.commandCount ?? 1).map(
            (command) => ({
              capabilityId: "execute_command",
              controls: { command, cwd: "." },
            }),
          );
      const model = createExecApprovalScript(
        options.policy,
        actions,
        options.ordinary ? "approval_fixture" : "exec",
      );
      const policy = resolveRequestExecutionPolicy(options.policy);
      const seed: RequestExecutionSeed = {
        requestId: "exec-approval-request",
        sessionId: "exec-approval-session",
        prompt: "Perform the exact fixture actions.",
        historyMessages: [],
        shouldGenerateSessionTitle: false,
        runnerConfig: {
          models: { defaults: { profileId: "fixture", steps: {} } },
          context: {
            outputReserveTokens: 1000,
            safetyReserveTokens: 200,
            attachmentReserveTokens: 100,
          },
          steps: Object.fromEntries(
            [
              "supervisor.decision",
              "worker.decision",
              "worker.result",
              "supervisor.response",
              "execution.decision",
              "execution.response",
              "capability.controls",
            ].map((step) => [step, { timeoutMs: 5000 }]),
          ),
        },
        executionPolicySelection: {
          policy: options.policy,
          source: "model_profile",
        },
        modelPolicy: {
          providers: { local: { type: "ollama" } },
          profiles: {
            fixture: {
              provider: "local",
              model: "injected-only",
              contextWindowTokens: 64_000,
            },
          },
          defaults: { profileId: "fixture", steps: {} },
        },
        modelGatewayClient: model,
        agentMode: "reasoning",
        toolPermissionMode: options.mode,
        ...(options.approval
          ? { toolApprovalController: options.approval }
          : {}),
        abortSignal: controller.signal,
        onAcknowledgement: vi.fn(),
        onSessionTitle: vi.fn(async () => undefined),
        onThinkingDelta: vi.fn(),
        onThinkingTrace: vi.fn(),
        onAnswerToken,
        onEvent,
      };
      const request = createTestRequestExecutionScopeWithCapabilities(
        seed,
        (view) =>
          createRequestWorkerCapabilityProvider({
            request: view,
            executionPolicyAuthority: policy.authority,
            runtimeConfig: config,
            toolRegistryOverride: registry,
          }),
        { executionPolicy: policy },
      );
      return { model, pending: runRequestRunner(request) };
    },
  };
}
