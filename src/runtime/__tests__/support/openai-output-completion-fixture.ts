import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { vi } from "vitest";
import { createModelGatewayClient } from "../../../model-gateway/client.js";
import { createModelGatewayServer } from "../../../model-gateway/server.js";
import type { RegisteredToolNormalInvocation } from "../../../capabilities/tool-types.js";
import type { ModelGatewayClient, ToolRegistry } from "../../ports.js";
import { createRegisteredToolWorkerCapabilityProvider } from "../../adapters/registered-tool-worker-capabilities.js";
import { createRequestWorkerCapabilityPayloadAuthor } from "../../request/worker-capability-payload.js";
import { createRootInvalidOutputRequest } from "./root-invalid-output-fixture.js";

export type ResponseEnding = "completed" | "eof" | "done";
export type ProviderOutput = Readonly<{ text: string; ending?: ResponseEnding }>;
export const COMPLETE_RAW_BODY = '{"label":"complete content","count":2}\n';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing_fixture_port");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((done) => {
    server.close(() => done());
    server.closeAllConnections();
  });
}

function responseFrames(output: ProviderOutput): string {
  const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const text = frame({ type: "response.output_text.delta", delta: output.text });
  if (output.ending === "eof") return text;
  if (output.ending === "done") return text + "data: [DONE]\n\n";
  return text + frame({ type: "response.completed", response: { status: "completed" } });
}

/** Real HTTP gateway and OpenAI adapter; only the remote provider is scripted. */
export async function openAICompletionGateway(outputs: readonly ProviderOutput[]) {
  const artifacts = resolve(".codex/artifacts/openai-stream-completion-20261012");
  await mkdir(artifacts, { recursive: true });
  const rootDir = await mkdtemp(join(artifacts, "runtime-completion-"));
  vi.stubEnv("COMPLETION_INTEGRATION_KEY", "local-provider-fixture");
  let outputIndex = 0;
  const provider = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const output = outputs[outputIndex++];
      if (!output) {
        res.writeHead(500);
        res.end("unexpected_provider_invocation");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(responseFrames(output));
    });
  });
  const modelPolicy = {
    providers: { test: { type: "openai", baseUrl: await listen(provider), apiKeyEnv: "COMPLETION_INTEGRATION_KEY" } },
    profiles: { test: { provider: "test", model: "fixture", contextWindowTokens: 128_000 } },
    defaults: { profileId: "test", steps: {} },
  };
  await writeFile(join(rootDir, "runtime.config.json"), JSON.stringify({
    logging: { enabled: false }, models: modelPolicy, requestRunner: { configRef: "./runner.json" },
  }));
  await writeFile(join(rootDir, "runner.json"), JSON.stringify({
    schemaVersion: 2, models: { defaults: { profileId: "test", steps: {} } },
    context: { outputReserveTokens: 1_000, safetyReserveTokens: 200, attachmentReserveTokens: 100 },
    stepDefaults: { timeoutMs: 5_000 }, steps: {},
  }));
  const gateway = createModelGatewayServer({ rootDir, modelPolicy });
  const client = createModelGatewayClient({ baseUrl: await listen(gateway) });
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(client.invoke);
  const modelGatewayClient = { invoke, invokeRaw: client.invokeRaw };
  return {
    rootDir, modelPolicy, invoke, modelGatewayClient,
    dispose: async () => {
      await close(gateway);
      await close(provider);
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

export const mutationDecision = {
  action: "invoke_capability", capabilityId: "write_fixture",
  intent: "Write the requested document.",
  workingDirectory: ".",
};

export function decisionOutput(decision: unknown): string {
  return JSON.stringify({ decision });
}

export function createCompletionDecisionRequest(fixture: Awaited<ReturnType<typeof openAICompletionGateway>>) {
  const execute = vi.fn(async () => ({
    outcome: "succeeded" as const, observedEffect: "mutation" as const, summary: "The document was written.",
  }));
  const descriptor = {
    capabilityId: "write_fixture", summary: "Write the requested document.", effect: "mutation" as const,
    catalogGroups: ["files"], controlsRefinement: "mechanical_when_complete" as const,
    controls: { type: "object" as const, additionalProperties: false as const, properties: {}, required: [] },
  };
  const request = createRootInvalidOutputRequest(fixture.invoke, "execution-agent-v1", {
    modelPolicy: fixture.modelPolicy, modelGatewayClient: fixture.modelGatewayClient,
    workerCapabilityProvider: {
      getDescriptors: () => [descriptor], getAdapters: () => [{ descriptor, execute }],
    },
  });
  return { request, execute };
}

/** Request-bound RAW author and registered mutating adapter, with a real file effect. */
export function createCompletionPayloadExecution(fixture: Awaited<ReturnType<typeof openAICompletionGateway>>) {
  const target = join(fixture.rootDir, "authored.json");
  const registration: RegisteredToolNormalInvocation = {
    toolName: "completion_payload_sink",
    definition: {
      name: "completion_payload_sink", routingCapability: "filesystem_mutation", executionEffect: "mutating",
      params: { body: "string" },
    },
    contract: { version: 1, operations: [{
      operationId: "write_fixture", summary: "Write the requested document.",
      effect: "mutating", approval: "request_policy",
      input: { type: "object", additionalProperties: false, properties: {}, required: [] },
      payload: { kind: "raw_text", param: "body", instructions: "Produce the requested complete document.", minBytes: 1, maxBytes: 4_096 },
    }] },
  };
  const execute = vi.fn<ToolRegistry["execute"]>(async (invocation) => {
    await writeFile(target, String(invocation.params.body), "utf8");
    return { ok: true, tool: registration.toolName, output: "written", producedNewInformation: true, data: { mutationEvidence: true } };
  });
  const registry: ToolRegistry = {
    listDefinitions: () => [registration.definition], listNormalInvocations: () => [registration],
    getDefinition: (name) => name === registration.toolName ? registration.definition : undefined,
    hasToolsAvailable: () => true, getImplementations: () => ({}), execute,
  };
  const request = createRootInvalidOutputRequest(fixture.invoke, "execution-agent-v1", {
    modelPolicy: fixture.modelPolicy, modelGatewayClient: fixture.modelGatewayClient,
  });
  const payloadAuthor = createRequestWorkerCapabilityPayloadAuthor(request, ["root"]);
  const provider = createRegisteredToolWorkerCapabilityProvider<Record<string, never>>({
    getRequestToolRegistry: () => registry, requestId: request.requestId, sessionId: request.sessionId,
    abortSignal: request.abortSignal, toolPermissionMode: "full_access", nextApprovalId: () => "unused",
    payloadAuthor, onEvent: vi.fn(),
  });
  const adapter = provider.getAdapters()[0]!;
  return {
    target, execute,
    run: () => adapter.execute({
      context: {}, executionId: "capability-execution-1", intent: "Write the requested document.",
      authoringObjective: "Produce the complete document.", controls: {}, settledCapabilityResults: [],
      call: {
        callId: "call-1", parentCallId: null, roleId: "supervisor", depth: 0, objective: null,
        dependencyResultRefs: [], status: "active", childCallIds: [], activationCount: 1, resultRef: null,
      },
      executionFreshness: {
        token: { kind: "request_steering_v1", version: 0, updates: [] }, isCurrent: () => true,
      },
    }),
  };
}
