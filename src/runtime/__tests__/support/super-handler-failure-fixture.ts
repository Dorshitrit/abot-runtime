import { writeFile } from "node:fs/promises";
import { vi } from "vitest";
import type WebSocket from "ws";
import { createInMemorySessionStore } from "../../adapters/in-memory-session-store.js";
import type { ModelGatewayClient } from "../../ports.js";
import { handleRunRequest } from "../../request/handler.js";
import type {
  RequestHandlerOptions,
  RunRequestMessage,
} from "../../request/contracts.js";
import { createRuntimeConfig } from "./runtime-composition-fixture.js";
import { INVALID_OUTPUT_MODEL_POLICY } from "./root-invalid-output-fixture.js";

export async function createFailureHarness(
  policyId:
    | "supervisor-worker-v1"
    | "execution-agent-v1" = "supervisor-worker-v1",
) {
  const runtimeConfig = {
    ...(await createRuntimeConfig()),
    plugins: { enabled: false },
    models: INVALID_OUTPUT_MODEL_POLICY,
    modelExecutionPolicies: { "invalid-output-test": { policy: policyId } },
  };
  await writeFile(
    runtimeConfig.requestRunner.configPath!,
    JSON.stringify({
      schemaVersion: 2,
      models: { defaults: { profileId: "invalid-output-test", steps: {} } },
      context: {
        outputReserveTokens: 1000,
        safetyReserveTokens: 200,
        attachmentReserveTokens: 100,
      },
      stepDefaults: { timeoutMs: 20000 },
      steps: {},
    }),
  );
  const sessionStore = createInMemorySessionStore();
  await sessionStore.getOrCreateSession("failure-session");
  await sessionStore.updateSessionTitle("failure-session", "Existing session");
  const events: Record<string, unknown>[] = [];
  let rejectedEventType: string | undefined;
  const ws = {
    send(data: string) {
      const event = JSON.parse(data);
      events.push(event);
      if (event.type === rejectedEventType)
        throw new Error("transport_delivery_failed");
    },
  } as unknown as WebSocket;
  const originalAppend = sessionStore.appendMessage.bind(sessionStore);
  const append = vi.spyOn(sessionStore, "appendMessage");
  return {
    runtimeConfig,
    sessionStore,
    events,
    append,
    originalAppend,
    rejectTransport: (type: string) => {
      rejectedEventType = type;
    },
    run: (
      invoke: ModelGatewayClient["invoke"],
      options: RequestHandlerOptions = {},
      input: Partial<RunRequestMessage> = {},
    ) =>
      handleRunRequest(
        ws,
        {
          type: "run_request",
          requestId: "failure-request",
          sessionId: "failure-session",
          input: "Finish the requested work.",
          agentMode: "reasoning",
          modelPreference: { profileId: "invalid-output-test", scope: "all" },
          ...input,
        },
        {
          runtimeConfig,
          sessionStore,
          modelGatewayClient: { invoke, invokeRaw: vi.fn() },
          ...options,
        },
      ),
  };
}
