import type { RuntimePluginEntrypoint } from "../../plugin-contract/entrypoint.js";
import type {
  ToolCallAdapter,
  ToolImplementation,
} from "../../capabilities/tool-types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function validateManifestEntrypoint(params: {
  pluginId: string;
  expectedCapabilityIds: readonly string[];
  raw: unknown;
}): RuntimePluginEntrypoint {
  if (!isRecord(params.raw) || !isRecord(params.raw.handlers)) {
    throw new Error(
      `Runtime plugin ${params.pluginId} entrypoint must export handlers`,
    );
  }
  const unsupported = Object.keys(params.raw).find(
    (key) => !["handlers", "adapters", "prepareRequest"].includes(key),
  );
  if (unsupported) {
    throw new Error(
      `Runtime plugin ${params.pluginId} entrypoint contains unsupported field ${unsupported}`,
    );
  }
  const handlers = validateEntrypointHandlers(
    params.pluginId,
    params.expectedCapabilityIds,
    params.raw.handlers,
  );
  const adapters = validateEntrypointAdapters(
    params.pluginId,
    params.expectedCapabilityIds,
    params.raw.adapters,
  );
  const prepareRequest = params.raw.prepareRequest;
  if (!isOptionalEntrypointFunction(prepareRequest)) {
    throw new Error(
      `Runtime plugin ${params.pluginId} prepareRequest must be a function`,
    );
  }
  return {
    handlers,
    ...(prepareRequest
      ? {
          prepareRequest:
            prepareRequest as RuntimePluginEntrypoint["prepareRequest"],
        }
      : {}),
    ...(Object.keys(adapters).length > 0 ? { adapters } : {}),
  };
}

function validateEntrypointHandlers(
  pluginId: string,
  expectedCapabilityIds: readonly string[],
  raw: Record<string, unknown>,
): Record<string, ToolImplementation> {
  const handlers: Record<string, ToolImplementation> = {};
  for (const [capabilityId, handler] of Object.entries(raw)) {
    if (typeof handler !== "function") {
      throw new Error(
        `Runtime plugin ${pluginId} handler ${capabilityId} must be a function`,
      );
    }
    handlers[capabilityId] = handler as ToolImplementation;
  }
  const expected = new Set(expectedCapabilityIds);
  const missing = expectedCapabilityIds.filter((id) => !handlers[id]);
  const unexpected = Object.keys(handlers).filter((id) => !expected.has(id));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Runtime plugin ${pluginId} handler mismatch: missing=${missing.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"}`,
    );
  }
  return handlers;
}

function validateEntrypointAdapters(
  pluginId: string,
  expectedCapabilityIds: readonly string[],
  raw: unknown,
): Record<string, ToolCallAdapter> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    throw new Error(
      `Runtime plugin ${pluginId} entrypoint adapters must be an object`,
    );
  }
  const adapters: Record<string, ToolCallAdapter> = {};
  for (const [capabilityId, adapter] of Object.entries(raw)) {
    if (!expectedCapabilityIds.includes(capabilityId)) {
      throw new Error(
        `Runtime plugin ${pluginId} adapter ${capabilityId} has no declared capability`,
      );
    }
    adapters[capabilityId] = validateEntrypointAdapter(
      pluginId,
      capabilityId,
      adapter,
    );
  }
  return adapters;
}

function validateEntrypointAdapter(
  pluginId: string,
  capabilityId: string,
  raw: unknown,
): ToolCallAdapter {
  const label = `Runtime plugin ${pluginId} adapter ${capabilityId}`;
  if (!isRecord(raw)) throw new Error(`${label} must be an object`);
  const fields = ["normalizeCall", "validateCall", "executionBinding"];
  const unsupported = Object.keys(raw).find((key) => !fields.includes(key));
  if (unsupported)
    throw new Error(`${label} contains unsupported field ${unsupported}`);
  const invalidFunction = fields.find(
    (key) => !isOptionalEntrypointFunction(raw[key]),
  );
  if (invalidFunction)
    throw new Error(`${label}.${invalidFunction} must be a function`);
  return raw as ToolCallAdapter;
}

function isOptionalEntrypointFunction(value: unknown): boolean {
  return value === undefined || typeof value === "function";
}
