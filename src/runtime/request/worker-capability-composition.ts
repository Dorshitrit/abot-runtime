import { allowsAutomaticPayloadArtifactLoading } from "./execution-payload-artifact-policy.js";
import type { KnowledgeSkillStore } from "../knowledge-skills/store.js";
import {
  projectAvailableSkills,
  type AvailableSkillsSource,
} from "../knowledge-skills/available-skills.js";
import { randomUUID } from "node:crypto";
import type { RuntimeModelPluginConfig } from "../config/model-plugin-config.js";
import type { RuntimeFilesystemScope } from "../context/runtime-filesystem-scope.js";

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
  requestWorkingDirectory?: string;
  filesystemScope?: RuntimeFilesystemScope;
  executionPolicyAuthority?: ExecutionPolicyAuthoritySnapshot;
  modelPlugins?: RuntimeModelPluginConfig;
  requestAttachments?: readonly ToolRequestAttachment[];
  runtimeConfig?: RuntimeConfig;
  toolRegistryOverride?: ToolRegistry;
  knowledgeSkillStore?: KnowledgeSkillStore;
}>;

/**
 * Creates one lazy, request-scoped Worker capability source from declarative
 * role config and the neutral runtime Tool Registry.
 */
export function createRequestWorkerCapabilityProvider(
  params: RequestWorkerCapabilityProviderParams<RequestCapabilityCompositionView>,
): WorkerCapabilityAdapterProvider<RequestCapabilityExecutionView> &
  ToolAvailabilitySource & AvailableSkillsSource {
  let requestToolRegistry: ToolRegistry | undefined;
  let requestSkillProvider: SkillProvider | undefined;

  function getRequestToolRegistry(): ToolRegistry {
    requestToolRegistry ??= createRequestRuntimeToolRegistry({
      request: params.request,
      requestWorkingDirectory: params.requestWorkingDirectory,
      toolPermissionMode: params.request.toolPermissionMode,
      ...(params.modelPlugins ? { modelPlugins: params.modelPlugins } : {}),
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
        allowRelatedArtifactLoading: allowsAutomaticPayloadArtifactLoading(
          params.executionPolicyAuthority,
        ),
        requestId: params.request.requestId,
        ...(params.request.toolResources
          ? { toolResources: params.request.toolResources }
          : {}),
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
          params.filesystemScope,
        ),
        loadActionSkillContext: (toolName) =>
          getRequestSkillProvider().getActionContext(toolName),
        nextApprovalId: () => `approval:${randomUUID()}`,
        onEvent: params.request.onEvent,
        ...(params.request.effectPersistence
          ? { effectPersistence: params.request.effectPersistence }
          : {}),
      },
    );
  const getAvailableTools = () =>
    projectAvailableTools(getRequestToolRegistry().listNormalInvocations?.());
  return Object.freeze({
    ...provider,
    getAvailableTools,
    getAvailableSkills: () => projectAvailableSkills(
      params.knowledgeSkillStore,
      getAvailableTools(),
    ),
  });
}
