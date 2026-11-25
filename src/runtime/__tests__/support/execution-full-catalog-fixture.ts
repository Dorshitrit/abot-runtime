import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { createDefaultToolRegistry } from "../../default-adapters.js";
import { restrictToolRegistryToRequestMode } from "../../capabilities/request-permission-tool-registry.js";
import { resolveRegisteredToolCapabilityCatalog } from "../../adapters/registered-tool-worker-capabilities/catalog.js";
import { builtinKnowledgeSkillStore } from "../../knowledge-skills/catalog.js";
import type { SchedulerService } from "../../scheduler/contracts.js";
import type { InformationBasketService } from "../../information-basket/contracts.js";
import type { CapabilityDescriptor } from "../../orchestration/capability-adapters/index.js";
import {
  createRoleCallLedger, ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH, ROLE_CALL_RESULT_MAX_LENGTH,
} from "../../orchestration/role-calls/index.js";
import { EXECUTION_AGENT_V1_EXECUTION_POLICY } from "../../request/role-executor-composition.js";
import { createRequestSteeringInbox } from "../../request/request-steering.js";
import { buildExecutionAgentInput } from "../../steps/execution-agent/input.js";
import { loadPublicRuntimeConfig } from "../public-runtime-config-fixture.js";
import { createTestRequestExecutionScope } from "./request-execution-scope.js";
import { executionPrefixCachePolicy } from "./execution-prefix-cache-fixture.js";

function unexpectedExecution(): never {
  throw new Error("catalog_fixture_must_not_execute");
}

function unavailableService<T extends object>(): T {
  return new Proxy({} as T, { get: unexpectedExecution });
}

/** Real installed declarations, including core services; no host discovery or execution. */
export function loadFullExecutionCatalog() {
  const root = mkdtempSync(join(tmpdir(), "ea-full-catalog-"));
  try {
    const source = loadPublicRuntimeConfig([]);
    const config = { ...source, paths: { ...source.paths,
      rootDir: root, runtimeDir: join(root, ".runtime"), agentWorkDir: join(root, "work"),
      workspaceDir: join(root, "workspace"),
    } };
    const installed = createDefaultToolRegistry(config,
      { service: unavailableService<SchedulerService>(), ready: unexpectedExecution },
      { getService: unexpectedExecution, ready: unexpectedExecution },
      builtinKnowledgeSkillStore, unavailableService<InformationBasketService>(),
    );
    const registry = restrictToolRegistryToRequestMode(installed, "full_access", undefined, "execution-agent-v1");
    return {
      descriptors: resolveRegisteredToolCapabilityCatalog(registry, true).descriptors,
      operationIds: registry.listNormalInvocations!().flatMap(({ contract }) =>
        contract.operations.map(({ operationId }) => operationId)),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export async function createFullCatalogDecisionFixture(capabilities: readonly CapabilityDescriptor[]) {
  const requestId = "full-catalog-cache-test";
  const steering = createRequestSteeringInbox({ requestId });
  const request = createTestRequestExecutionScope({
    requestId, sessionId: "full-catalog-cache-session", prompt: "Inspect and update the requested local file.",
    historyMessages: [], shouldGenerateSessionTitle: false,
    modelPolicy: executionPrefixCachePolicy,
    executionPolicySelection: { policy: "execution-agent-v1", primaryProfileId: "test", source: "model_profile" },
    runnerConfig: {
      models: { defaults: { profileId: "test", steps: { "execution.decision": "execution.decision" } } },
      context: { outputReserveTokens: 4096, safetyReserveTokens: 1200, attachmentReserveTokens: 100 },
      steps: { "execution.decision": { timeoutMs: 20000 } },
    },
    agentMode: "reasoning", toolPermissionMode: "full_access", requestSteering: steering,
    modelGatewayClient: { invoke: vi.fn(unexpectedExecution), invokeRaw: vi.fn(unexpectedExecution),
      countInputTokens: vi.fn(unexpectedExecution) },
    workerCapabilityProvider: { getDescriptors: () => capabilities, getAdapters: () => [] },
    abortSignal: new AbortController().signal,
    onAcknowledgement: vi.fn(), onSessionTitle: vi.fn(async () => undefined),
    onThinkingDelta: vi.fn(), onThinkingTrace: vi.fn(), onAnswerToken: vi.fn(), onEvent: vi.fn(),
  });
  const ledger = createRoleCallLedger({ requestId, policy: {
    authority: EXECUTION_AGENT_V1_EXECUTION_POLICY.authority,
    limits: { maxDepth: 12, maxCalls: 48, maxCapabilityExecutions: 192,
      maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH, maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
      maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH },
  } });
  async function commit(command: unknown) {
    const result = await ledger.apply({ expectedHead: ledger.current(), command });
    if (!result.ok) throw new Error(`full_catalog_fixture_${result.code}`);
  }
  await commit({ authority: "runtime", type: "create_root" });
  function activeCall() {
    const head = ledger.current();
    const call = head.state.calls.find(({ callId }) => callId === head.state.activeCallId);
    if (!call) throw new Error("full_catalog_fixture_active_call_missing");
    return call;
  }
  return {
    request,
    input: () => buildExecutionAgentInput(request, {
      head: ledger.current(), call: activeCall(), steeringSnapshot: steering.snapshot(),
      includeAcknowledgement: false, includeTitle: false, allowPlanner: true, allowAuditor: true,
    }),
    scope: (mode: "open" | "extend", catalogGroupIds: readonly string[]) => {
      const call = activeCall();
      return commit({ authority: "active_role", type: "update_capability_scope", callId: call.callId,
        invocationAttempt: call.activationCount, mode, catalogGroupIds: [...catalogGroupIds] });
    },
  };
}
