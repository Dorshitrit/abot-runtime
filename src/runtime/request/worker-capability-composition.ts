import { randomUUID } from "node:crypto";

import {
  createBundledPluginSkillProvider,
  createConfiguredSkillProvider,
} from "../adapters/configured-skill-provider.js";
import { createRegisteredToolWorkerCapabilityProvider } from "../adapters/registered-tool-worker-capabilities.js";
import type {
  RuntimeConfig,
  SkillProvider,
  ToolApprovalController,
  ToolPermissionMode,
  ToolRegistry,
} from "../ports.js";
import type { ToolRequestAttachment } from "../../capabilities/tool-types.js";
import type { WorkerCapabilityAdapterProvider } from "../orchestration/worker-capabilities/index.js";
import { createRequestRuntimeToolRegistry } from "../capabilities/request-runtime-tool-registry.js";
import {
  projectAvailableTools,
  type ToolAvailabilitySource,
} from "../capabilities/tool-availability.js";
import { createRequestWorkerCapabilityPayloadAuthor } from "./worker-capability-payload.js";
import type { ExecutionPolicyAuthoritySnapshot } from "../orchestration/role-calls/index.js";
import type {
  RequestCapabilityCompositionView,
  RequestCapabilityExecutionView,
} from "./execution-scope.js";

type RequestWorkerCapabilityProviderParams<TRequest> = Readonly<{
  request: TRequest;
  executionPolicyAuthority?: ExecutionPolicyAuthoritySnapshot;
  requestAttachments?: readonly ToolRequestAttachment[];
  runtimeConfig?: RuntimeConfig;
  toolRegistryOverride?: ToolRegistry;
}>;

/**
 * Creates one lazy, request-scoped Worker capability source from declarative
 * role config and the neutral runtime Tool Registry.
 */
export function createRequestWorkerCapabilityProvider(
  params: RequestWorkerCapabilityProviderParams<RequestCapabilityCompositionView>,
): WorkerCapabilityAdapterProvider<RequestCapabilityExecutionView> &
  ToolAvailabilitySource {
  let requestToolRegistry: ToolRegistry | undefined;
  let requestSkillProvider: SkillProvider | undefined;

  function getRequestToolRegistry(): ToolRegistry {
    requestToolRegistry ??= createRequestRuntimeToolRegistry({
      request: params.request,
      ...(params.requestAttachments
        ? { requestAttachments: params.requestAttachments }
        : {}),
      ...(params.runtimeConfig ? { runtimeConfig: params.runtimeConfig } : {}),
      ...(params.toolRegistryOverride
        ? { toolRegistryOverride: params.toolRegistryOverride }
        : {}),
    });
    return requestToolRegistry;
  }

  function getRequestSkillProvider(): SkillProvider {
    if (!requestSkillProvider) {
      const listToolDefinitions = () =>
        getRequestToolRegistry().listDefinitions();
      requestSkillProvider = params.runtimeConfig
        ? createConfiguredSkillProvider({
            config: params.runtimeConfig,
            listToolDefinitions,
          })
        : createBundledPluginSkillProvider({ listToolDefinitions });
    }
    return requestSkillProvider;
  }

  const provider =
    createRegisteredToolWorkerCapabilityProvider<RequestCapabilityExecutionView>(
      {
        getRequestToolRegistry,
        requestId: params.request.requestId,
        sessionId: params.request.sessionId,
        requestContext: Object.freeze({
          agentMode: params.request.agentMode,
          toolPermissionMode: params.request.toolPermissionMode,
          ...(params.request.modelPreference
            ? { modelPreference: params.request.modelPreference }
            : {}),
        }),
        abortSignal: params.request.abortSignal,
        toolPermissionMode: params.request.toolPermissionMode,
        ...(params.request.toolApprovalController
          ? {
              toolApprovalController: params.request.toolApprovalController,
            }
          : {}),
        payloadAuthor: createRequestWorkerCapabilityPayloadAuthor(
          params.request,
          params.executionPolicyAuthority?.capabilityAuthorities,
        ),
        loadActionSkillContext: (toolName) =>
          getRequestSkillProvider().getActionContext(toolName),
        nextApprovalId: () => `approval:${randomUUID()}`,
        onEvent: params.request.onEvent,
      },
    );
  return Object.freeze({
    ...provider,
    getAvailableTools: () =>
      projectAvailableTools(getRequestToolRegistry().listNormalInvocations?.()),
  });
}
