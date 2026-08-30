import type { ToolDefinition } from "../tool-types.js";
import {
  isDevelopmentRole,
  isExecutionEffect,
  isRoutingCapability,
  parseParamsByCommand,
  parseRuntimePathBindings,
  parseToolCatalogGroups,
} from "./definition-fields.js";
import { parseEventPresentation } from "./event-presentation.js";
import { parsePayloadChannelSpec } from "./payload-channel-spec.js";
import { isToolDefinitionRecordValue } from "./definition-shape.js";

export function parseToolDefinition(raw: unknown): ToolDefinition {
  if (!isToolDefinitionRecordValue(raw)) {
    throw new Error("Invalid tool definition entry (not an object)");
  }
  const name = raw.name;
  const description = raw.description;
  const routingCapability = raw.routingCapability;
  const controlsRefinement = raw.controlsRefinement;
  const catalogGroups = raw.catalogGroups;
  const executionEffect = raw.executionEffect;
  const developmentRoles = raw.developmentRoles;
  const eventPresentation = raw.eventPresentation;
  const params = raw.params;

  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error("Invalid tool definition entry (name)");
  }

  if (description !== undefined && typeof description !== "string") {
    throw new Error(`Invalid tool definition for ${name} (description)`);
  }
  if (!isRoutingCapability(routingCapability)) {
    throw new Error(`Invalid tool definition for ${name} (routingCapability)`);
  }
  if (
    controlsRefinement !== undefined &&
    controlsRefinement !== "mechanical_when_complete"
  ) {
    throw new Error(`Invalid tool definition for ${name} (controlsRefinement)`);
  }
  if (executionEffect !== undefined && !isExecutionEffect(executionEffect)) {
    throw new Error(`Invalid tool definition for ${name} (executionEffect)`);
  }
  if (!isToolDefinitionRecordValue(params)) {
    throw new Error(`Invalid tool definition for ${name} (params)`);
  }
  if (!hasSupportedDevelopmentRoles(developmentRoles)) {
    throw new Error(`Invalid tool definition for ${name} (developmentRoles)`);
  }
  for (const [paramName, paramType] of Object.entries(params)) {
    if (typeof paramType !== "string") {
      throw new Error(
        `Invalid tool definition for ${name} (param type for ${paramName})`,
      );
    }
  }

  const paramsByCommand = parseParamsByCommand(name, raw.paramsByCommand);
  const runtimePathBindings = parseRuntimePathBindings(
    name,
    raw.runtimePathBindings,
  );
  const payloadChannelSpec = parsePayloadChannelSpec(
    name,
    params as Record<string, string>,
    raw.payloadChannelSpec,
  );
  const parsedEventPresentation = parseEventPresentation(
    name,
    eventPresentation,
  );

  return {
    name,
    ...(typeof description === "string" ? { description } : {}),
    routingCapability,
    ...(controlsRefinement === "mechanical_when_complete"
      ? { controlsRefinement }
      : {}),
    catalogGroups: parseToolCatalogGroups(name, catalogGroups),
    ...(executionEffect ? { executionEffect } : {}),
    ...(Array.isArray(developmentRoles)
      ? { developmentRoles: [...developmentRoles] }
      : {}),
    ...(parsedEventPresentation
      ? { eventPresentation: parsedEventPresentation }
      : {}),
    params: params as Record<string, string>,
    ...(paramsByCommand ? { paramsByCommand } : {}),
    ...(payloadChannelSpec ? { payloadChannelSpec } : {}),
    ...(runtimePathBindings ? { runtimePathBindings } : {}),
  };
}

function hasSupportedDevelopmentRoles(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  return value.every(isDevelopmentRole);
}
