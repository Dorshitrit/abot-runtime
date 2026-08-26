// GENERATED FILE - DO NOT EDIT.
// Source: plugins/system-probe/source/index.ts
// Run "npm run build:plugins" after editing plugin source.
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// plugins/system-probe/source/index.ts
var index_exports = {};
__export(index_exports, {
  default: () => index_default
});
module.exports = __toCommonJS(index_exports);
var import_promises = require("node:fs/promises");

// src/plugin-sdk/parameters.ts
var PluginParameterError = class extends TypeError {
  code;
  parameter;
  constructor(params) {
    super(params.message ?? `${params.parameter}: ${params.code}`);
    this.name = "PluginParameterError";
    this.code = params.code;
    this.parameter = params.parameter;
  }
};
function isPluginParameterError(error) {
  return error instanceof PluginParameterError;
}
function stringOptions(input) {
  return typeof input === "string" ? { name: input } : input;
}
function parameterName(options) {
  return options.name ?? options.parameter ?? "value";
}
function parseString(value, options) {
  if (value === void 0 || value === null) return void 0;
  const parameter = parameterName(options);
  if (typeof value !== "string") {
    throw new PluginParameterError({
      code: "plugin_parameter_invalid",
      parameter
    });
  }
  const parsed = options.trim === false ? value : value.trim();
  if (options.minLength !== void 0 && parsed.length < options.minLength || options.maxLength !== void 0 && parsed.length > options.maxLength) {
    throw new PluginParameterError({
      code: "plugin_parameter_invalid",
      parameter
    });
  }
  return parsed;
}
function readOptionalString(value, input = {}) {
  return parseString(value, stringOptions(input));
}

// src/plugin-sdk/paths.ts
function resolvePluginPath(context, rawPath, options = {}) {
  return context.runtimePathResolver.resolve(rawPath, options);
}
function runtimeToolPathErrorCode(error) {
  if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string" || !error.code.startsWith("runtime_tool_path_")) {
    return void 0;
  }
  return error.code;
}

// src/plugin-sdk/plugin.ts
function defineRuntimePlugin(definition) {
  return definition;
}

// src/plugin-sdk/results.ts
var PLUGIN_RESULT_SERIALIZED_MAX_BYTES = 128 * 1024;
function resultBoundsFailure(code, message) {
  return {
    ok: false,
    output: message,
    producedNewInformation: false,
    error: message,
    errorCode: code
  };
}
function enforcePluginResultByteBudget(result) {
  let serialized;
  try {
    const candidate = JSON.stringify(result);
    if (candidate === void 0) {
      return resultBoundsFailure(
        "plugin_result_not_json_safe",
        "The plugin produced a result that is not JSON-safe."
      );
    }
    serialized = candidate;
  } catch {
    return resultBoundsFailure(
      "plugin_result_not_json_safe",
      "The plugin produced a result that is not JSON-safe."
    );
  }
  if (Buffer.byteLength(serialized, "utf8") > PLUGIN_RESULT_SERIALIZED_MAX_BYTES) {
    return resultBoundsFailure(
      "plugin_result_too_large",
      `The plugin result exceeds the ${PLUGIN_RESULT_SERIALIZED_MAX_BYTES}-byte safety limit.`
    );
  }
  return result;
}
function successResult(input) {
  return enforcePluginResultByteBudget({
    ok: true,
    output: input.output,
    producedNewInformation: input.producedNewInformation ?? true,
    ...input.progress !== void 0 ? { progress: input.progress } : {},
    ...input.actions !== void 0 ? { actions: input.actions } : {},
    ...input.exitCode !== void 0 ? { exitCode: input.exitCode } : {},
    ...input.stdout !== void 0 ? { stdout: input.stdout } : {},
    ...input.stderr !== void 0 ? { stderr: input.stderr } : {},
    ...input.data !== void 0 ? { data: input.data } : {}
  });
}
function failureResult(input) {
  return enforcePluginResultByteBudget({
    ok: false,
    output: input.output ?? input.message,
    producedNewInformation: false,
    ...input.progress !== void 0 ? { progress: input.progress } : {},
    ...input.actions !== void 0 ? { actions: input.actions } : {},
    ...input.exitCode !== void 0 ? { exitCode: input.exitCode } : {},
    ...input.stdout !== void 0 ? { stdout: input.stdout } : {},
    ...input.stderr !== void 0 ? { stderr: input.stderr } : {},
    ...input.data !== void 0 ? { data: input.data } : {},
    error: input.message,
    errorCode: input.errorCode
  });
}
function failureFromError(error, options) {
  const pathCode = runtimeToolPathErrorCode(error);
  const parameterCode = isPluginParameterError(error) ? error.code : void 0;
  const errorCode = pathCode ?? parameterCode ?? options.fallbackCode;
  const message = pathCode ?? parameterCode ?? options.fallbackMessage;
  return failureResult({
    errorCode,
    message,
    output: options.operation ? `${options.operation} failed: ${message}` : message
  });
}

// plugins/system-probe/source/metrics.ts
var import_node_os = __toESM(require("node:os"), 1);
function bytesToGiB(bytes) {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`;
}
function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds % 86400 / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}
function readMachineMetrics() {
  const memoryTotalBytes = import_node_os.default.totalmem();
  const memoryFreeBytes = import_node_os.default.freemem();
  const loadAverage = import_node_os.default.loadavg();
  const cpuCount = import_node_os.default.cpus().length;
  const loadPerCpu = cpuCount > 0 ? (loadAverage[0] ?? 0) / cpuCount : loadAverage[0] ?? 0;
  const loadLevel = loadPerCpu < 0.5 ? "low" : loadPerCpu < 1 ? "moderate" : "high";
  return Object.freeze({
    platform: import_node_os.default.platform(),
    architecture: import_node_os.default.arch(),
    uptimeSeconds: import_node_os.default.uptime(),
    cpuCount,
    loadAverage: Object.freeze(loadAverage),
    loadLevel,
    memoryTotalBytes,
    memoryFreeBytes,
    memoryUsedBytes: Math.max(0, memoryTotalBytes - memoryFreeBytes)
  });
}

// plugins/system-probe/source/index.ts
var ALLOWED_PATH_LOCATIONS = Object.freeze([
  "agent_work",
  "workspace",
  "host_system"
]);
function filesystemErrorCode(error) {
  if (!error || typeof error !== "object" || !("code" in error))
    return void 0;
  return typeof error.code === "string" ? error.code : void 0;
}
var index_default = defineRuntimePlugin((context) => ({
  handlers: {
    async system_probe(params) {
      const explicitPath = readOptionalString(params.path);
      try {
        const target = resolvePluginPath(context, explicitPath ?? "/", {
          requirePath: true,
          allowedLocations: ALLOWED_PATH_LOCATIONS
        });
        let disk;
        let diskStatus = "available";
        try {
          const info = await (0, import_promises.statfs)(target.absolutePath);
          const blockSize = Number(info.bsize);
          const totalBytes = blockSize * Number(info.blocks);
          const freeBytes = blockSize * Number(info.bavail);
          disk = Object.freeze({
            totalBytes,
            freeBytes,
            usedBytes: Math.max(0, totalBytes - freeBytes)
          });
        } catch (error) {
          if (explicitPath) {
            const code = filesystemErrorCode(error);
            if (code === "ENOENT" || code === "ENOTDIR") {
              return failureResult({
                errorCode: "system_probe_path_not_found",
                message: "The requested disk-probe path does not exist."
              });
            }
            if (code === "EACCES" || code === "EPERM") {
              return failureResult({
                errorCode: "system_probe_path_inaccessible",
                message: "The requested disk-probe path is not accessible."
              });
            }
            return failureResult({
              errorCode: "system_probe_disk_unavailable",
              message: "Disk statistics are unavailable for the requested path."
            });
          }
          diskStatus = "unavailable";
        }
        const machine = readMachineMetrics();
        const output = [
          "System probe summary:",
          "system_status: responsive",
          `platform: ${machine.platform}`,
          `arch: ${machine.architecture}`,
          `uptime: ${formatDuration(machine.uptimeSeconds)}`,
          `cpu_count: ${machine.cpuCount}`,
          `load_level: ${machine.loadLevel}`,
          `load_average: ${machine.loadAverage.map((value) => value.toFixed(2)).join(" ")}`,
          `memory_used: ${bytesToGiB(machine.memoryUsedBytes)} / ${bytesToGiB(machine.memoryTotalBytes)}`,
          `memory_free: ${bytesToGiB(machine.memoryFreeBytes)}`,
          `disk_path: ${target.logicalPath}`,
          `disk_status: ${diskStatus}`,
          ...disk ? [
            `disk_used: ${bytesToGiB(disk.usedBytes)} / ${bytesToGiB(disk.totalBytes)}`,
            `disk_free: ${bytesToGiB(disk.freeBytes)}`
          ] : []
        ].join("\n");
        return successResult({
          output,
          producedNewInformation: true,
          data: {
            hasData: true,
            itemCount: 1,
            diskPath: target.logicalPath,
            diskStatus,
            machine,
            ...disk ? { disk } : {},
            observationMeta: {
              kind: "volatile_external",
              carryPolicy: "never"
            }
          }
        });
      } catch (error) {
        return failureFromError(error, {
          fallbackCode: "system_probe_failed",
          fallbackMessage: "System probe failed.",
          operation: "system_probe"
        });
      }
    }
  }
}));
