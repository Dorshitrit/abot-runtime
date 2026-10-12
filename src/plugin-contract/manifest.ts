import type {
  ToolCatalogGroup,
  ToolDevelopmentRole,
  ToolEventPresentation,
  ToolNormalInvocationApproval,
  ToolNormalInvocationAttachmentInput,
  ToolNormalInvocationEffect,
  ToolNormalInvocationFixedValue,
  ToolNormalInvocationInput,
  ToolNormalInvocationPayload,
  ToolNormalInvocationOutputChannels,
  ToolPayloadChannelSpec,
  ToolRoutingCapability,
  ToolRuntimePathBinding,
} from "../capabilities/tool-types.js";
import {
  ABOT_PLUGIN_COMPATIBILITY_EXTENSION,
  type PluginPlatformDeclaration,
} from "./platform-compatibility.js";
export const AGENT_PLUGIN_MANIFEST_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const ABOT_RUNTIME_EXTENSION = "ai.abot.runtime";
export const ABOT_RUNTIME_EXTENSION_VERSION = 1 as const;

export type AgentPluginOperationManifest = Readonly<{
  summary: string;
  outputChannels?: ToolNormalInvocationOutputChannels;
  input: ToolNormalInvocationInput;
  selectionControlIds?: readonly string[];
  effect: ToolNormalInvocationEffect;
  approval: ToolNormalInvocationApproval;
  fixedParams?: Readonly<Record<string, ToolNormalInvocationFixedValue>>;
  payload?: ToolNormalInvocationPayload;
  attachmentInput?: ToolNormalInvocationAttachmentInput;
}>;

export type AgentPluginCapabilityManifest = Readonly<{
  requiredPermissionMode?: import("../capabilities/tool-permission-mode.js").ToolRequiredPermissionMode;
  description: string;
  routingCapability: ToolRoutingCapability;
  controlsRefinement?: "mechanical_when_complete";
  catalogGroups?: readonly ToolCatalogGroup[];
  skills: readonly string[];
  developmentRoles?: readonly ToolDevelopmentRole[];
  eventPresentation?: ToolEventPresentation;
  payloadChannelSpec?: ToolPayloadChannelSpec;
  runtimePathBindings?: readonly ToolRuntimePathBinding[];
  operations: Readonly<Record<string, AgentPluginOperationManifest>>;
}>;

export type AgentPluginSecretManifest = Readonly<{
  env: string;
  required: boolean;
}>;

export type AgentPluginSettingsManifest = Readonly<{
  defaults: Readonly<Record<string, unknown>>;
}>;

export type AbotRuntimePluginExtension = Readonly<{
  version: typeof ABOT_RUNTIME_EXTENSION_VERSION;
  entrypoint: string;
  catalogGroups?: readonly ToolCatalogGroup[];
  settings?: AgentPluginSettingsManifest;
  secrets?: Readonly<Record<string, AgentPluginSecretManifest>>;
  capabilities: Readonly<Record<string, AgentPluginCapabilityManifest>>;
}>;

export type AgentPluginManifest = Readonly<{
  $schema: typeof AGENT_PLUGIN_MANIFEST_SCHEMA;
  name: string;
  version?: string;
  description?: string;
  extensions: Readonly<{
    [ABOT_RUNTIME_EXTENSION]: AbotRuntimePluginExtension;
    [ABOT_PLUGIN_COMPATIBILITY_EXTENSION]?: PluginPlatformDeclaration;
    [namespace: string]: unknown;
  }>;
}>;
