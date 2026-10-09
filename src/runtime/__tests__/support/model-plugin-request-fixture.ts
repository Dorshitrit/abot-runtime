import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { vi } from "vitest";
import type { ToolModuleDeclaration } from "../../../capabilities/tool-types.js";
import { successResult } from "../../../plugin-sdk/index.js";
import { createConfiguredToolRegistry } from "../../capabilities/configured-tool-registry.js";
import type { RequestExecutionPolicyId } from "../../config/model-execution-policy.js";
import { createLocalRuntimeOwner } from "../../local-host/app-owner.js";
import type { ModelGatewayClient, RuntimeConfig } from "../../ports.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import * as preparation from "../../request/prepared-execution.js";
import { processDebugLogger } from "../../observability/debug-logger.js";
import { createExecApprovalScript } from "./exec-sensitive-approval-script.js";
import { makeOwnerControlPeer } from "./local-runtime-owner-peer.js";

export async function createModelPluginRequestFixture(
  policy: RequestExecutionPolicyId,
  overrideClientPreference = false,
) {
  const artifacts = resolve(".codex/artifacts/model-plugin-permissions");
  await mkdir(artifacts, { recursive: true });
  const rootDir = await mkdtemp(join(artifacts, "request-integration-"));
  const configPath = join(rootDir, "request-runner.json");
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 2,
      models: { defaults: { profileId: "restricted", steps: {} } },
      context: {
        outputReserveTokens: 1000,
        safetyReserveTokens: 200,
        attachmentReserveTokens: 100,
      },
      stepDefaults: { timeoutMs: 5000 },
      steps: {},
    }),
  );
  const config: RuntimeConfig = {
    runtimeId: "model-plugin-request-test",
    agentBridgeUrl: "ws://unused",
    modelGatewayUrl: "http://unused",
    requestRunner: { configPath },
    plugins: { enabled: false },
    logging: {
      enabled: false,
      rotation: { maxFileSizeMb: 1, maxFiles: 1, maxAgeDays: 1 },
    },
    paths: {
      rootDir,
      runtimeDir: join(rootDir, "runtime"),
      agentWorkDir: join(rootDir, "work"),
      sessionsDir: join(rootDir, "sessions"),
      attachmentsDir: join(rootDir, "attachments"),
      workspaceDir: join(rootDir, "workspace"),
      sharedDir: join(rootDir, "shared"),
      compiledDir: join(rootDir, "compiled"),
      traceFile: join(rootDir, "trace.jsonl"),
    },
    models: {
      defaults: { profileId: "restricted", overrideClientPreference },
      providers: { local: { type: "ollama" } },
      profiles: Object.fromEntries(
        ["restricted", "unrestricted"].map((id) => [
          id,
          {
            provider: "local",
            model: id,
            contextWindowTokens: 64000,
          },
        ]),
      ),
    },
    modelExecutionPolicies: {
      restricted: { policy, plugins: { deny: ["blocked-plugin"] } },
      unrestricted: { policy },
    },
  };
  const effects = {
    allowed: vi.fn(async () =>
      successResult({ output: "Allowed fixture effect." }),
    ),
    blocked: vi.fn(async () =>
      successResult({ output: "Blocked fixture effect." }),
    ),
  };
  const modules: ToolModuleDeclaration[] = (
    ["allowed", "blocked"] as const
  ).map((name) => ({
    definition: {
      name: `${name}_tool`,
      pluginName: `${name}-plugin`,
      routingCapability: "semantic_mutation",
      catalogGroups: ["fixture"],
    },
    normalInvocation: {
      version: 1,
      operations: [
        {
          operationId: `${name}_effect`,
          summary: `Perform the ${name} fixture effect.`,
          effect: "mutating",
          approval: "request_policy",
          input: {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      ],
    },
    implementation: effects[name],
  }));
  const scripts = new Map<
    string,
    ReturnType<typeof createExecApprovalScript>
  >();
  const models: ModelGatewayClient = {
    invoke: vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      const script = scripts.get(input.debugRequestId ?? "");
      if (!script) throw new Error("missing_model_plugin_request_script");
      return script.invoke(input);
    }),
    invokeRaw: vi.fn(async () => {
      throw new Error("unexpected_raw_model_call");
    }),
  };
  const scopes: RequestExecutionScope[] = [];
  const prepare = preparation.prepareRequestExecution;
  vi.spyOn(preparation, "prepareRequestExecution").mockImplementation(
    async (input) => {
      const prepared = await prepare(input);
      scopes.push(prepared.request);
      return prepared;
    },
  );
  const owners: Awaited<ReturnType<typeof createLocalRuntimeOwner>>[] = [];
  const peer = makeOwnerControlPeer("model-plugin-request-peer").peer;
  const start = async () => {
    const owner = await createLocalRuntimeOwner(config, {
      models,
      tools: createConfiguredToolRegistry(config, modules),
    });
    owners.push(owner);
    return owner;
  };
  return {
    config,
    effects,
    scopes,
    scripts,
    start,
    peer,
    async run(
      owner: Awaited<ReturnType<typeof start>>,
      requestId: string,
      profileId: string | undefined,
      capabilityId = "allowed_effect",
      durable = false,
    ) {
      await owner.call("sessions.getOrCreateSession", [requestId], peer);
      await owner.call(
        "sessions.updateSessionTitle",
        [requestId, "Established fixture conversation"],
        peer,
      );
      scripts.set(
        requestId,
        createExecApprovalScript(
          policy,
          [{ capabilityId, controls: {} }],
          "fixture",
        ),
      );
      return owner.call(
        "request.run",
        [
          {
            type: "run_request",
            requestId,
            sessionId: requestId,
            text: "Perform the fixture effect.",
            agentMode: "reasoning",
            toolPermissionMode: durable ? "ask" : "full_access",
            ...(profileId
              ? { modelPreference: { profileId, scope: "main" } }
              : {}),
          },
          ...(durable
            ? [{ durableApprovals: true, approvalAvailable: true }]
            : []),
        ],
        peer,
      );
    },
    async dispose() {
      for (const owner of owners.reverse()) {
        await owner.stop();
        await owner.whenIdle?.();
      }
      await processDebugLogger.drain();
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}
