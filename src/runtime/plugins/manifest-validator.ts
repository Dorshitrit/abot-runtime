import type {
  AgentPluginCapabilityManifest,
  AgentPluginManifest,
  AgentPluginOperationManifest,
  AgentPluginSecretManifest,
  AgentPluginSettingsManifest,
  AbotRuntimePluginExtension,
} from "../../plugin-contract/manifest.js";
import { isToolCatalogGroupId } from "../../capabilities/tool-types.js";
import {
  ABOT_RUNTIME_EXTENSION,
  ABOT_RUNTIME_EXTENSION_VERSION,
  AGENT_PLUGIN_MANIFEST_SCHEMA,
} from "../../plugin-contract/manifest.js";

const PLUGIN_NAME_PATTERN =
  /^(?!.*(?:--|\.\.))[a-z0-9][a-z0-9.-]{0,62}[a-z0-9]$|^[a-z0-9]$/u;
const SECRET_ENV_PATTERN = /^[A-Z][A-Z0-9_]*$/u;
const ROUTING_CAPABILITIES = [
  "filesystem_inspection",
  "filesystem_mutation",
  "semantic_lookup",
  "semantic_mutation",
  "web_lookup",
] as const;
const DEVELOPMENT_ROLES = [
  "inspect",
  "establish",
  "mutate",
  "verify",
  "auxiliary",
] as const;
const EVENT_PROJECTION_KINDS = [
  "string",
  "number",
  "string_array",
  "length",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    throw new Error(`${path} contains unknown field ${unknown[0]}`);
  }
}

function parseSkills(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }
  const skills = value.map((skill, index) => {
    if (!nonEmptyString(skill)) {
      throw new Error(`${path}.${index} must be a non-empty string`);
    }
    return skill.trim();
  });
  if (new Set(skills).size !== skills.length) {
    throw new Error(`${path} must not contain duplicates`);
  }
  return skills;
}

function parseFixedParams(
  value: unknown,
  path: string,
): Record<string, string | number | boolean> | undefined {
  if (value === undefined) return undefined;
  const fixed = expectRecord(value, path);
  const parsed: Record<string, string | number | boolean> = {};
  for (const [name, item] of Object.entries(fixed)) {
    if (!nonEmptyString(name)) {
      throw new Error(`${path} contains an empty parameter name`);
    }
    if (
      typeof item !== "string" &&
      typeof item !== "number" &&
      typeof item !== "boolean"
    ) {
      throw new Error(`${path}.${name} must be a string, number, or boolean`);
    }
    parsed[name] = item;
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function parseDevelopmentRoles(
  value: unknown,
  path: string,
): Array<(typeof DEVELOPMENT_ROLES)[number]> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }
  const roles = value.map((role, index) => {
    if (
      !DEVELOPMENT_ROLES.includes(role as (typeof DEVELOPMENT_ROLES)[number])
    ) {
      throw new Error(`${path}.${index} is not a supported development role`);
    }
    return role as (typeof DEVELOPMENT_ROLES)[number];
  });
  return roles.length > 0 ? [...new Set(roles)] : undefined;
}

function parseToolCatalogGroups(
  value: unknown,
  path: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${path} must be a non-empty array`);
  }
  const groups = value.map((group, index) => {
    if (!isToolCatalogGroupId(group)) {
      throw new Error(`${path}.${index} is not a valid catalog group id`);
    }
    return group;
  });
  if (new Set(groups).size !== groups.length) {
    throw new Error(`${path} must not contain duplicates`);
  }
  return groups;
}

function parseRuntimePathBindings(
  value: unknown,
  path: string,
): AgentPluginCapabilityManifest["runtimePathBindings"] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new Error(`${path} must be a non-empty array of at most 32 bindings`);
  }
  const identities = new Set<string>();
  return value.map((entry, index) => {
    const binding = expectRecord(entry, `${path}.${index}`);
    rejectUnknownKeys(
      binding,
      ["operationId", "param", "base", "default"],
      `${path}.${index}`,
    );
    if (
      !nonEmptyString(binding.operationId) ||
      !nonEmptyString(binding.param) ||
      binding.base !== "worker_working_directory" ||
      (binding.default !== undefined && binding.default !== ".")
    ) {
      throw new Error(
        `${path}.${index} requires operationId, param, and base=worker_working_directory`,
      );
    }
    const operationId = binding.operationId.trim();
    const param = binding.param.trim();
    const identity = `${operationId}\u0000${param}`;
    if (identities.has(identity)) {
      throw new Error(`${path} must not contain duplicate operation bindings`);
    }
    identities.add(identity);
    return Object.freeze({
      operationId,
      param,
      base: "worker_working_directory" as const,
      ...(binding.default === "." ? { default: "." as const } : {}),
    });
  });
}

function parsePayloadChannelSpec(
  value: unknown,
  path: string,
): AgentPluginCapabilityManifest["payloadChannelSpec"] | undefined {
  if (value === undefined) return undefined;
  const payload = expectRecord(value, path);
  rejectUnknownKeys(
    payload,
    [
      "params",
      "outputParam",
      "generationMode",
      "targetParam",
      "targetRole",
      "contextScope",
      "targetContext",
      "responseFormat",
      "promptHint",
      "stages",
      "groundingWindow",
      "requiresCurrentTargetObservation",
    ],
    path,
  );
  // Cross-field and operation-parameter validation is intentionally owned by
  // validateToolModuleDeclarations after this manifest is projected once.
  return { ...payload } as AgentPluginCapabilityManifest["payloadChannelSpec"];
}

function parseEventPresentation(
  value: unknown,
  path: string,
): AgentPluginCapabilityManifest["eventPresentation"] | undefined {
  if (value === undefined) return undefined;
  const presentation = expectRecord(value, path);
  rejectUnknownKeys(presentation, ["metadata", "lifecycle"], path);
  const metadata = expectRecord(presentation.metadata, `${path}.metadata`);
  const lifecycle = presentation.lifecycle;
  if (lifecycle !== undefined && !isRecord(lifecycle)) {
    throw new Error(`${path}.lifecycle must be an object`);
  }
  const parsedLifecycle = lifecycle
    ? Object.fromEntries(
        ["started", "completed", "failed"].flatMap((phase) => {
          const rawCopy = lifecycle[phase];
          if (rawCopy === undefined) return [];
          const copy = expectRecord(rawCopy, `${path}.lifecycle.${phase}`);
          rejectUnknownKeys(
            copy,
            ["status", "message"],
            `${path}.lifecycle.${phase}`,
          );
          if (!nonEmptyString(copy.status) || !nonEmptyString(copy.message)) {
            throw new Error(
              `${path}.lifecycle.${phase} requires non-empty status and message`,
            );
          }
          return [
            [
              phase,
              { status: copy.status.trim(), message: copy.message.trim() },
            ],
          ];
        }),
      )
    : undefined;
  return {
    metadata: Object.fromEntries(
      Object.entries(metadata).map(([key, rawProjection]) => {
        if (!nonEmptyString(key)) {
          throw new Error(`${path}.metadata contains an empty key`);
        }
        const projection = expectRecord(
          rawProjection,
          `${path}.metadata.${key}`,
        );
        rejectUnknownKeys(
          projection,
          ["param", "kind", "default"],
          `${path}.metadata.${key}`,
        );
        if (!nonEmptyString(projection.param)) {
          throw new Error(`${path}.metadata.${key}.param must be non-empty`);
        }
        if (
          !EVENT_PROJECTION_KINDS.includes(
            projection.kind as (typeof EVENT_PROJECTION_KINDS)[number],
          )
        ) {
          throw new Error(`${path}.metadata.${key}.kind is not supported`);
        }
        const fallback = projection.default;
        if (
          fallback !== undefined &&
          typeof fallback !== "string" &&
          typeof fallback !== "number" &&
          typeof fallback !== "boolean"
        ) {
          throw new Error(
            `${path}.metadata.${key}.default must be a string, number, or boolean`,
          );
        }
        return [
          key,
          {
            param: projection.param.trim(),
            kind: projection.kind as (typeof EVENT_PROJECTION_KINDS)[number],
            ...(fallback !== undefined ? { default: fallback } : {}),
          },
        ];
      }),
    ),
    ...(parsedLifecycle && Object.keys(parsedLifecycle).length > 0
      ? { lifecycle: parsedLifecycle }
      : {}),
  };
}

function parseSettings(
  value: unknown,
  path: string,
): AgentPluginSettingsManifest | undefined {
  if (value === undefined) return undefined;
  const settings = expectRecord(value, path);
  rejectUnknownKeys(settings, ["defaults"], path);
  return { defaults: expectRecord(settings.defaults, `${path}.defaults`) };
}

function parseSecrets(
  value: unknown,
  path: string,
): Record<string, AgentPluginSecretManifest> | undefined {
  if (value === undefined) return undefined;
  const secrets = expectRecord(value, path);
  const parsed: Record<string, AgentPluginSecretManifest> = {};
  for (const [name, rawSecret] of Object.entries(secrets)) {
    if (!nonEmptyString(name)) {
      throw new Error(`${path} contains an empty secret name`);
    }
    const secret = expectRecord(rawSecret, `${path}.${name}`);
    rejectUnknownKeys(secret, ["env", "required"], `${path}.${name}`);
    if (!nonEmptyString(secret.env) || !SECRET_ENV_PATTERN.test(secret.env)) {
      throw new Error(
        `${path}.${name}.env must be an environment variable name`,
      );
    }
    if (typeof secret.required !== "boolean") {
      throw new Error(`${path}.${name}.required must be boolean`);
    }
    parsed[name] = { env: secret.env, required: secret.required };
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

type ParsedOperation = Readonly<{
  manifest: AgentPluginOperationManifest;
  legacySkills?: readonly string[];
}>;

function parseOperation(value: unknown, path: string): ParsedOperation {
  const operation = expectRecord(value, path);
  rejectUnknownKeys(
    operation,
    [
      "summary",
      "input",
      "effect",
      "approval",
      "skills",
      "fixedParams",
      "payload",
    ],
    path,
  );
  if (!nonEmptyString(operation.summary)) {
    throw new Error(`${path}.summary must be a non-empty string`);
  }
  const input = expectRecord(operation.input, `${path}.input`);
  if (!["read_only", "mutating", "mixed"].includes(String(operation.effect))) {
    throw new Error(`${path}.effect must be read_only, mutating, or mixed`);
  }
  if (!["request_policy", "always"].includes(String(operation.approval))) {
    throw new Error(`${path}.approval must be request_policy or always`);
  }
  const payload =
    operation.payload === undefined
      ? undefined
      : expectRecord(operation.payload, `${path}.payload`);
  const fixedParams = parseFixedParams(
    operation.fixedParams,
    `${path}.fixedParams`,
  );
  const legacySkills =
    operation.skills === undefined
      ? undefined
      : parseSkills(operation.skills, `${path}.skills`);
  return {
    manifest: {
      summary: operation.summary.trim(),
      input: input as AgentPluginOperationManifest["input"],
      effect: operation.effect as AgentPluginOperationManifest["effect"],
      approval: operation.approval as AgentPluginOperationManifest["approval"],
      ...(fixedParams ? { fixedParams } : {}),
      ...(payload
        ? { payload: payload as AgentPluginOperationManifest["payload"] }
        : {}),
    },
    ...(legacySkills ? { legacySkills } : {}),
  };
}

function parseOperations(
  value: unknown,
  path: string,
): Readonly<{
  manifests: Record<string, AgentPluginOperationManifest>;
  legacySkills: readonly string[];
  hasLegacySkills: boolean;
}> {
  const operations = expectRecord(value, path);
  if (Object.keys(operations).length === 0) {
    throw new Error(`${path} must declare at least one operation`);
  }
  const parsed: Array<readonly [string, ParsedOperation]> = Object.entries(
    operations,
  ).map(([operationId, operation]) => {
    if (!nonEmptyString(operationId)) {
      throw new Error(`${path} contains an empty operation id`);
    }
    return [
      operationId,
      parseOperation(operation, `${path}.${operationId}`),
    ] as const;
  });
  return {
    manifests: Object.fromEntries(
      parsed.map(([operationId, operation]) => [
        operationId,
        operation.manifest,
      ]),
    ),
    legacySkills: [
      ...new Set(
        parsed.flatMap(([, operation]) => operation.legacySkills ?? []),
      ),
    ],
    hasLegacySkills: parsed.some(
      ([, operation]) => operation.legacySkills !== undefined,
    ),
  };
}

function parseCapabilities(
  value: unknown,
  path: string,
): Record<string, AgentPluginCapabilityManifest> {
  const capabilities = expectRecord(value, path);
  if (Object.keys(capabilities).length === 0) {
    throw new Error(`${path} must declare at least one capability`);
  }
  return Object.fromEntries(
    Object.entries(capabilities).map(([capabilityId, rawCapability]) => {
      if (!nonEmptyString(capabilityId)) {
        throw new Error(`${path} contains an empty capability id`);
      }
      const capability = expectRecord(rawCapability, `${path}.${capabilityId}`);
      rejectUnknownKeys(
        capability,
        [
          "description",
          "routingCapability",
          "controlsRefinement",
          "catalogGroups",
          "skills",
          "developmentRoles",
          "eventPresentation",
          "payloadChannelSpec",
          "runtimePathBindings",
          "operations",
        ],
        `${path}.${capabilityId}`,
      );
      if (!nonEmptyString(capability.description)) {
        throw new Error(
          `${path}.${capabilityId}.description must be a non-empty string`,
        );
      }
      if (
        !ROUTING_CAPABILITIES.includes(
          capability.routingCapability as (typeof ROUTING_CAPABILITIES)[number],
        )
      ) {
        throw new Error(
          `${path}.${capabilityId}.routingCapability is not supported`,
        );
      }
      const developmentRoles = parseDevelopmentRoles(
        capability.developmentRoles,
        `${path}.${capabilityId}.developmentRoles`,
      );
      const catalogGroups = parseToolCatalogGroups(
        capability.catalogGroups,
        `${path}.${capabilityId}.catalogGroups`,
      );
      const eventPresentation = parseEventPresentation(
        capability.eventPresentation,
        `${path}.${capabilityId}.eventPresentation`,
      );
      const payloadChannelSpec = parsePayloadChannelSpec(
        capability.payloadChannelSpec,
        `${path}.${capabilityId}.payloadChannelSpec`,
      );
      const operations = parseOperations(
        capability.operations,
        `${path}.${capabilityId}.operations`,
      );
      const runtimePathBindings = parseRuntimePathBindings(
        capability.runtimePathBindings,
        `${path}.${capabilityId}.runtimePathBindings`,
      );
      const declaredSkills =
        capability.skills === undefined
          ? undefined
          : parseSkills(capability.skills, `${path}.${capabilityId}.skills`);
      const controlsRefinement = capability.controlsRefinement;
      if (
        controlsRefinement !== undefined &&
        controlsRefinement !== "mechanical_when_complete"
      ) {
        throw new Error(
          `${path}.${capabilityId}.controlsRefinement must be mechanical_when_complete`,
        );
      }
      if (
        declaredSkills &&
        operations.hasLegacySkills &&
        !sameStringSet(declaredSkills, operations.legacySkills)
      ) {
        throw new Error(
          `${path}.${capabilityId}.skills conflicts with legacy operation skills`,
        );
      }
      const skills = declaredSkills ?? operations.legacySkills;
      if (
        controlsRefinement === "mechanical_when_complete" &&
        skills.length > 0
      ) {
        throw new Error(
          `${path}.${capabilityId}.controlsRefinement requires empty skills`,
        );
      }
      return [
        capabilityId,
        {
          description: capability.description.trim(),
          routingCapability:
            capability.routingCapability as AgentPluginCapabilityManifest["routingCapability"],
          ...(controlsRefinement === "mechanical_when_complete"
            ? { controlsRefinement }
            : {}),
          ...(catalogGroups ? { catalogGroups } : {}),
          skills,
          ...(developmentRoles ? { developmentRoles } : {}),
          ...(eventPresentation ? { eventPresentation } : {}),
          ...(payloadChannelSpec ? { payloadChannelSpec } : {}),
          ...(runtimePathBindings ? { runtimePathBindings } : {}),
          operations: operations.manifests,
        },
      ];
    }),
  );
}

function sameStringSet(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length && left.every((value) => right.includes(value))
  );
}

function parseRuntimeExtension(value: unknown): AbotRuntimePluginExtension {
  const path = `extensions.${ABOT_RUNTIME_EXTENSION}`;
  const extension = expectRecord(value, path);
  rejectUnknownKeys(
    extension,
    [
      "version",
      "entrypoint",
      "catalogGroups",
      "settings",
      "secrets",
      "capabilities",
    ],
    path,
  );
  if (extension.version !== ABOT_RUNTIME_EXTENSION_VERSION) {
    throw new Error(
      `${path}.version must be ${ABOT_RUNTIME_EXTENSION_VERSION}`,
    );
  }
  if (!nonEmptyString(extension.entrypoint)) {
    throw new Error(`${path}.entrypoint must be a non-empty string`);
  }
  if (!extension.entrypoint.startsWith("./")) {
    throw new Error(`${path}.entrypoint must start with ./`);
  }
  const settings = parseSettings(extension.settings, `${path}.settings`);
  const secrets = parseSecrets(extension.secrets, `${path}.secrets`);
  const catalogGroups = parseToolCatalogGroups(
    extension.catalogGroups,
    `${path}.catalogGroups`,
  );
  return {
    version: ABOT_RUNTIME_EXTENSION_VERSION,
    entrypoint: extension.entrypoint,
    ...(catalogGroups ? { catalogGroups } : {}),
    ...(settings ? { settings } : {}),
    ...(secrets ? { secrets } : {}),
    capabilities: parseCapabilities(
      extension.capabilities,
      `${path}.capabilities`,
    ),
  };
}

export function parseAgentPluginManifest(
  raw: unknown,
  folderName: string,
): AgentPluginManifest {
  const manifest = expectRecord(raw, "plugin.json");
  if (manifest.$schema !== AGENT_PLUGIN_MANIFEST_SCHEMA) {
    throw new Error(
      `plugin.json.$schema must be ${AGENT_PLUGIN_MANIFEST_SCHEMA}`,
    );
  }
  if (
    !nonEmptyString(manifest.name) ||
    !PLUGIN_NAME_PATTERN.test(manifest.name)
  ) {
    throw new Error("plugin.json.name is not a valid Agent Plugins name");
  }
  if (manifest.name !== folderName) {
    throw new Error(
      `plugin folder ${folderName} must match plugin.json name ${manifest.name}`,
    );
  }
  if (manifest.version !== undefined && typeof manifest.version !== "string") {
    throw new Error("plugin.json.version must be a string");
  }
  if (
    manifest.description !== undefined &&
    typeof manifest.description !== "string"
  ) {
    throw new Error("plugin.json.description must be a string");
  }
  const extensions = expectRecord(
    manifest.extensions,
    "plugin.json.extensions",
  );
  const runtimeExtension = parseRuntimeExtension(
    extensions[ABOT_RUNTIME_EXTENSION],
  );
  return {
    $schema: AGENT_PLUGIN_MANIFEST_SCHEMA,
    name: manifest.name,
    ...(typeof manifest.version === "string"
      ? { version: manifest.version }
      : {}),
    ...(typeof manifest.description === "string"
      ? { description: manifest.description }
      : {}),
    extensions: {
      ...extensions,
      [ABOT_RUNTIME_EXTENSION]: runtimeExtension,
    },
  };
}
