// GENERATED FILE - DO NOT EDIT.
// Source: plugins/system/source/index.ts
// Run "npm run build:plugins" after editing plugin source.
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// plugins/system/source/index.ts
var index_exports = {};
__export(index_exports, {
  default: () => index_default
});
module.exports = __toCommonJS(index_exports);

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
function readRequiredString(value, input = {}) {
  const options = stringOptions(input);
  const parameter = parameterName(options);
  const parsed = parseString(value, {
    ...options,
    minLength: Math.max(options.minLength ?? 1, 1)
  });
  if (parsed === void 0) {
    throw new PluginParameterError({
      code: "plugin_parameter_required",
      parameter
    });
  }
  return parsed;
}
function readBoundedInteger(value, options) {
  const parameter = parameterName(options);
  const candidate = value === void 0 ? options.defaultValue : value;
  if (!Number.isSafeInteger(candidate) || candidate < options.minimum || candidate > options.maximum) {
    throw new PluginParameterError({
      code: candidate === void 0 ? "plugin_parameter_required" : "plugin_parameter_invalid",
      parameter
    });
  }
  return candidate;
}

// src/plugin-sdk/paths.ts
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
    ...input.media !== void 0 ? { media: input.media } : {},
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
    ...input.media !== void 0 ? { media: input.media } : {},
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

// src/capabilities/tool-media.ts
var TOOL_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

// src/computer-access/companion/broker-client.ts
var import_node_net = require("node:net");

// src/computer-access/companion/broker-location.ts
var import_node_crypto2 = require("node:crypto");
var import_node_fs2 = require("node:fs");
var import_node_path2 = require("node:path");
var import_node_os = require("node:os");

// src/computer-access/companion/private-store.ts
var import_node_crypto = require("node:crypto");
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
function hostStateDirectory(rootDir) {
  return (0, import_node_path.join)(rootDir, ".runtime", "system-host");
}
function ensureHostStateDirectory(directory) {
  (0, import_node_fs.mkdirSync)(directory, { recursive: true, mode: 448 });
  const stat2 = (0, import_node_fs.lstatSync)(directory);
  if (!stat2.isDirectory()) throw new Error("host_state_directory_invalid");
  if (process.platform === "win32") return;
  if (stat2.uid !== process.getuid?.())
    throw new Error("host_state_owner_invalid");
  if ((stat2.mode & 63) !== 0)
    throw new Error("host_state_directory_not_private");
}
function readHostPrivateJson(path) {
  try {
    const stat2 = (0, import_node_fs.lstatSync)(path);
    if (!stat2.isFile()) throw new Error("host_state_file_invalid");
    if (process.platform !== "win32") {
      if (stat2.uid !== process.getuid?.())
        throw new Error("host_state_owner_invalid");
      if ((stat2.mode & 63) !== 0)
        throw new Error("host_state_file_not_private");
    }
    if (stat2.size > 16384) throw new Error("host_state_file_too_large");
    return JSON.parse((0, import_node_fs.readFileSync)(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw error;
  }
}
function writeHostPrivateJson(path, value) {
  ensureHostStateDirectory((0, import_node_path.dirname)(path));
  const temporary = `${path}.${(0, import_node_crypto.randomUUID)()}.tmp`;
  try {
    (0, import_node_fs.writeFileSync)(temporary, JSON.stringify(value), {
      flag: "wx",
      mode: 384
    });
    (0, import_node_fs.renameSync)(temporary, path);
  } finally {
    try {
      (0, import_node_fs.unlinkSync)(temporary);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

// src/computer-access/companion/protocol.ts
var HOST_WIRE_MAX_BYTES = 256 * 1024;
var HOST_OPERATIONS = [
  "system_targets",
  "system_command",
  "system_applications",
  "system_launch"
];
function isHostOperation(value) {
  return HOST_OPERATIONS.some((operation) => operation === value);
}
function isHostRecord(value) {
  if (value === null) return false;
  if (typeof value !== "object") return false;
  return !Array.isArray(value);
}
function isHostIdentifier(value) {
  if (typeof value !== "string") return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
    value
  );
}
function isHostIdentityText(value, maximum) {
  if (typeof value !== "string") return false;
  if (value.length === 0) return false;
  if (value.length > maximum) return false;
  return !/[\x00-\x1f\x7f]/u.test(value);
}
function isHostIdentity(value) {
  if (!isHostRecord(value)) return false;
  if (Object.keys(value).some(
    (key) => !["name", "os", "user", "homeDir"].includes(key)
  ))
    return false;
  if (!["windows", "macos", "linux"].includes(String(value.os))) return false;
  if (!isHostIdentityText(value.name, 128)) return false;
  if (!isHostIdentityText(value.user, 128)) return false;
  return isHostIdentityText(value.homeDir, 4096);
}
function isHostToolResult(value) {
  if (!isHostRecord(value)) return false;
  if (typeof value.ok !== "boolean") return false;
  if (typeof value.producedNewInformation !== "boolean") return false;
  if (value.data !== void 0 && !isHostRecord(value.data)) return false;
  return typeof value.output === "string";
}

// src/computer-access/companion/broker-location.ts
function brokerRecordPath(rootDir) {
  return (0, import_node_path2.join)(hostStateDirectory(rootDir), "broker.json");
}
function brokerSocketDirectoryRoot() {
  if (process.platform === "darwin") return "/tmp";
  if (process.platform === "linux") return (0, import_node_os.tmpdir)();
  throw new Error("host_broker_requires_linux_runtime");
}
function brokerSocketPath(rootDir) {
  const socketRoot = brokerSocketDirectoryRoot();
  const key = (0, import_node_crypto2.createHash)("sha256").update((0, import_node_fs2.realpathSync)(rootDir)).digest("hex").slice(0, 20);
  return (0, import_node_path2.join)(
    socketRoot,
    `abot-host-${process.getuid?.()}-${key}`,
    "broker.sock"
  );
}
function isBrokerLocation(value) {
  if (!isHostRecord(value)) return false;
  if (!isHostIdentifier(value.ownerId)) return false;
  if (typeof value.token !== "string") return false;
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value.token)) return false;
  return typeof value.socketPath === "string";
}
function readBrokerLocation(rootDir) {
  const record2 = readHostPrivateJson(brokerRecordPath(rootDir));
  if (record2 === void 0) return void 0;
  if (!isBrokerLocation(record2)) throw new Error("host_broker_record_invalid");
  if (record2.socketPath !== brokerSocketPath(rootDir))
    throw new Error("host_broker_path_invalid");
  return record2;
}

// src/computer-access/companion/pairing-store.ts
var import_node_crypto3 = require("node:crypto");
var import_node_path3 = require("node:path");
function tokenDigest(token) {
  return (0, import_node_crypto3.createHash)("sha256").update(token).digest("hex");
}
function matchesToken(token, digest) {
  if (!/^[a-f0-9]{64}$/u.test(digest)) return false;
  return (0, import_node_crypto3.timingSafeEqual)(
    Buffer.from(tokenDigest(token), "hex"),
    Buffer.from(digest, "hex")
  );
}
function isBoundedPairingLifetime(lifetimeMs) {
  if (!Number.isSafeInteger(lifetimeMs)) return false;
  if (lifetimeMs < 1) return false;
  return lifetimeMs <= 15 * 6e4;
}
function isStoredPairing(value) {
  if (!isHostRecord(value)) return false;
  if (value.version !== 1) return false;
  if (value.pending !== void 0) {
    if (!isHostRecord(value.pending)) return false;
    if (typeof value.pending.digest !== "string") return false;
    if (typeof value.pending.expiresAt !== "number") return false;
  }
  if (value.bundleUpgrade !== void 0) {
    if (!isHostRecord(value.bundleUpgrade)) return false;
    if (typeof value.bundleUpgrade.digest !== "string") return false;
    if (typeof value.bundleUpgrade.expiresAt !== "number") return false;
    if (!isHostIdentifier(value.bundleUpgrade.hostId)) return false;
  }
  if (value.host === void 0) return true;
  if (!isHostRecord(value.host)) return false;
  if (!isHostIdentifier(value.host.hostId)) return false;
  if (!isHostIdentity(value.host.identity)) return false;
  return typeof value.host.credentialDigest === "string";
}
var HostPairingStore = class {
  constructor(rootDir, now = Date.now) {
    this.now = now;
    this.path = (0, import_node_path3.join)(hostStateDirectory(rootDir), "pairing.json");
  }
  now;
  path;
  read() {
    const value = readHostPrivateJson(this.path);
    if (value === void 0) return { version: 1 };
    if (!isStoredPairing(value)) throw new Error("host_pairing_state_invalid");
    return value;
  }
  host() {
    return this.read().host;
  }
  begin(lifetimeMs = 5 * 6e4) {
    if (!isBoundedPairingLifetime(lifetimeMs))
      throw new Error("host_pairing_lifetime_invalid");
    if (this.host()) throw new Error("host_already_paired");
    const code = (0, import_node_crypto3.randomBytes)(32).toString("base64url");
    const expiresAt = this.now() + lifetimeMs;
    writeHostPrivateJson(this.path, {
      version: 1,
      pending: { digest: tokenDigest(code), expiresAt }
    });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }
  authenticate(token) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return void 0;
    const record2 = this.read();
    if (record2.host && matchesToken(token, record2.host.credentialDigest))
      return "credential";
    if (!record2.pending) return void 0;
    if (record2.pending.expiresAt <= this.now()) return void 0;
    if (matchesToken(token, record2.pending.digest)) return "pairing";
    return void 0;
  }
  /** Download-only grant; it cannot replace or authenticate as the paired host. */
  beginBundleUpgrade(lifetimeMs = 15 * 6e4) {
    if (!isBoundedPairingLifetime(lifetimeMs))
      throw new Error("host_pairing_lifetime_invalid");
    const record2 = this.read();
    if (!record2.host) throw new Error("host_not_paired");
    const code = (0, import_node_crypto3.randomBytes)(32).toString("base64url");
    const expiresAt = this.now() + lifetimeMs;
    writeHostPrivateJson(this.path, {
      ...record2,
      bundleUpgrade: {
        digest: tokenDigest(code),
        expiresAt,
        hostId: record2.host.hostId
      }
    });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }
  authenticateBundleUpgrade(token) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return false;
    const record2 = this.read();
    if (!record2.host) return false;
    const grant = record2.bundleUpgrade;
    if (!grant) return false;
    if (grant.hostId !== record2.host.hostId) return false;
    if (grant.expiresAt <= this.now()) return false;
    return matchesToken(token, grant.digest);
  }
  consume(code, identity) {
    if (this.authenticate(code) !== "pairing")
      throw new Error("host_pairing_expired");
    const hostId = (0, import_node_crypto3.randomUUID)();
    const credential = (0, import_node_crypto3.randomBytes)(32).toString("base64url");
    writeHostPrivateJson(this.path, {
      version: 1,
      host: { hostId, identity, credentialDigest: tokenDigest(credential) }
    });
    return { hostId, credential };
  }
  revoke() {
    writeHostPrivateJson(this.path, { version: 1 });
  }
};

// src/computer-access/companion/broker-client.ts
async function callBroker(rootDir, request, signal) {
  const location = readBrokerLocation(rootDir);
  if (!location) throw new Error("host_broker_unavailable");
  if (signal?.aborted) throw new Error("host_request_cancelled");
  return new Promise((resolve, reject) => {
    const socket = (0, import_node_net.connect)(location.socketPath);
    let received = Buffer.alloc(0);
    let settled = false;
    let sent = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) {
        reject(
          sent && request.kind === "execute" ? new Error("host_outcome_unknown") : error
        );
        return;
      }
      resolve(result);
    };
    const abort = () => finish(
      new Error(sent ? "host_outcome_unknown" : "host_request_cancelled")
    );
    const deadline = setTimeout(
      abort,
      request.kind === "status" ? 3e3 : 615e3
    );
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("connect", () => {
      const bytes = JSON.stringify({ ...request, version: 1, token: location.token }) + "\n";
      if (Buffer.byteLength(bytes) > HOST_WIRE_MAX_BYTES) {
        finish(new Error("host_request_too_large"));
        return;
      }
      sent = true;
      socket.write(bytes);
    });
    socket.on(
      "error",
      () => finish(
        new Error(sent ? "host_outcome_unknown" : "host_broker_unavailable")
      )
    );
    socket.on(
      "close",
      () => finish(
        new Error(sent ? "host_outcome_unknown" : "host_broker_unavailable")
      )
    );
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length > HOST_WIRE_MAX_BYTES) {
        finish(new Error("host_response_too_large"));
        return;
      }
      const boundary = received.indexOf(10);
      if (boundary < 0) return;
      if (boundary !== received.length - 1) {
        finish(new Error("host_response_invalid"));
        return;
      }
      try {
        finish(
          void 0,
          JSON.parse(received.subarray(0, boundary).toString())
        );
      } catch {
        finish(new Error("host_response_invalid"));
      }
    });
  });
}
function isHostStatus(value) {
  if (!isHostRecord(value)) return false;
  if (typeof value.paired !== "boolean") return false;
  if (typeof value.connected !== "boolean") return false;
  if (!hasValidHostConnectionBinding(value)) return false;
  if (!value.paired) return value.connected === false;
  if (!isHostIdentifier(value.hostId)) return false;
  return isHostIdentity(value.identity);
}
function hasValidHostConnectionBinding(value) {
  if (value.connected === true) return isHostIdentifier(value.connectionId);
  return !Object.hasOwn(value, "connectionId");
}
async function readHostStatus(rootDir) {
  try {
    const response = await callBroker(rootDir, { kind: "status" });
    if (!isHostRecord(response)) throw new Error("host_response_invalid");
    if (!isHostStatus(response.status)) throw new Error("host_status_invalid");
    return response.status;
  } catch {
    const host = new HostPairingStore(rootDir).host();
    if (!host) return { paired: false, connected: false };
    return {
      paired: true,
      connected: false,
      hostId: host.hostId,
      identity: host.identity
    };
  }
}
async function executeHostOperation(rootDir, input) {
  if (!isHostIdentifier(input.connectionId))
    return failureResult({
      errorCode: "system_host_binding_invalid",
      message: "An observed host connection identity is required before dispatch.",
      data: { outcome: "not_dispatched", retrySafe: true }
    });
  try {
    const response = await callBroker(
      rootDir,
      {
        kind: "execute",
        hostId: input.hostId,
        connectionId: input.connectionId,
        operation: input.operation,
        params: input.params
      },
      input.abortSignal
    );
    if (!isHostRecord(response)) throw new Error("host_outcome_unknown");
    if (response.ok !== true) throw new Error("host_outcome_unknown");
    if (!isHostToolResult(response.result))
      throw new Error("host_outcome_unknown");
    return response.result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "host_request_failed";
    const uncertain = message === "host_outcome_unknown";
    return failureResult({
      errorCode: uncertain ? "system_host_outcome_unknown" : "system_host_unavailable",
      message: uncertain ? "Host communication ended after dispatch. Effects may remain; inspect before retrying. The action was not replayed." : "The selected host connection is unavailable. No fallback target was used.",
      data: {
        outcome: uncertain ? "unknown" : "not_dispatched",
        retrySafe: !uncertain
      }
    });
  }
}

// src/computer-access/contracts.ts
var SystemOperationError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
  code;
};

// src/computer-access/computer/action-input.ts
function computerInputError(message) {
  throw new SystemOperationError("computer_input_invalid", message);
}
function computerRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return computerInputError("An object is required.");
  return value;
}
function computerFields(value, fields) {
  if (Object.keys(value).some((key) => !fields.includes(key)))
    computerInputError("Unexpected computer operation fields.");
}
function computerText(value, maximum = 4096) {
  if (typeof value !== "string")
    return computerInputError("A string is required.");
  if (value.length > maximum)
    return computerInputError("Computer text exceeds its limit.");
  return value;
}
function computerNumber(value, minimum, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value))
    return computerInputError("A finite number is required.");
  if (value < minimum || value > maximum)
    return computerInputError(
      "Computer coordinate or duration is out of range."
    );
  return value;
}
function readPhysicalRectangle(value) {
  const rect = computerRecord(value);
  computerFields(rect, ["x", "y", "width", "height"]);
  return {
    x: computerNumber(rect.x, -131072, 131072),
    y: computerNumber(rect.y, -131072, 131072),
    width: computerNumber(rect.width, 1, 65536),
    height: computerNumber(rect.height, 1, 65536)
  };
}
function readPoint(value) {
  const point = computerRecord(value);
  computerFields(point, ["x", "y"]);
  return {
    x: computerNumber(point.x, -131072, 131072),
    y: computerNumber(point.y, -131072, 131072)
  };
}
function readButton(value) {
  if (value === "left" || value === "middle" || value === "right") return value;
  return computerInputError("Select left, middle or right button.");
}
function readNativeComputerAction(value) {
  const action = computerRecord(value);
  switch (action.kind) {
    case "click": {
      computerFields(action, ["kind", "point", "button", "count"]);
      if (action.count !== 1 && action.count !== 2)
        return computerInputError("Click count must be one or two.");
      return {
        kind: action.kind,
        point: readPoint(action.point),
        button: readButton(action.button),
        count: action.count
      };
    }
    case "move":
      computerFields(action, ["kind", "point"]);
      return { kind: action.kind, point: readPoint(action.point) };
    case "drag":
      computerFields(action, ["kind", "from", "to", "button", "durationMs"]);
      return {
        kind: action.kind,
        from: readPoint(action.from),
        to: readPoint(action.to),
        button: readButton(action.button),
        durationMs: computerNumber(action.durationMs, 0, 5e3)
      };
    case "scroll":
      computerFields(action, ["kind", "deltaX", "deltaY"]);
      return {
        kind: action.kind,
        deltaX: computerNumber(action.deltaX, -5e3, 5e3),
        deltaY: computerNumber(action.deltaY, -5e3, 5e3)
      };
    case "type_text":
      computerFields(action, ["kind", "text"]);
      return { kind: action.kind, text: computerText(action.text, 4096) };
    case "press_keys": {
      computerFields(action, ["kind", "keys"]);
      if (!Array.isArray(action.keys))
        return computerInputError("Keys must be an array.");
      if (action.keys.length < 1 || action.keys.length > 8)
        return computerInputError("Use one to eight explicit keys.");
      return {
        kind: action.kind,
        keys: action.keys.map((key) => computerText(key, 32))
      };
    }
    case "focus_window":
      computerFields(action, ["kind", "windowBinding"]);
      return {
        kind: action.kind,
        windowBinding: computerText(action.windowBinding)
      };
    default:
      return computerInputError("Unknown computer action.");
  }
}

// src/computer-access/computer/companion-backend.ts
var import_node_crypto4 = require("node:crypto");

// src/computer-access/computer/native-validation.ts
var COMPUTER_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
var COMPUTER_FRAME_CHUNK_BYTES = 64 * 1024;
var COMPUTER_CAPABILITY = "computer_control_v1";
function readNativeComputerRequest(value) {
  const request = computerRecord(value);
  if (request.operation === "inspect") {
    computerFields(request, ["operation"]);
    return { operation: request.operation };
  }
  if (request.operation === "observe") {
    return readNativeObservationRequest(request);
  }
  if (request.operation !== "act")
    return computerInputError("Unknown desktop request.");
  computerFields(request, [
    "operation",
    "desktopBinding",
    "expectedWindow",
    "expectedGeometry",
    "action",
    "deadlineEpochMs"
  ]);
  return {
    operation: request.operation,
    desktopBinding: computerText(request.desktopBinding),
    ...request.expectedWindow === void 0 ? {} : { expectedWindow: computerText(request.expectedWindow) },
    expectedGeometry: readPhysicalRectangle(request.expectedGeometry),
    action: readNativeComputerAction(request.action),
    deadlineEpochMs: computerNumber(
      request.deadlineEpochMs,
      0,
      Number.MAX_SAFE_INTEGER
    )
  };
}
function readNativeObservationRequest(request) {
  if (request.region === void 0) {
    computerFields(request, ["operation"]);
    return {
      operation: "observe"
    };
  }
  computerFields(request, [
    "operation",
    "region",
    "desktopBinding",
    "expectedGeometry"
  ]);
  return {
    operation: "observe",
    region: readPhysicalRectangle(request.region),
    desktopBinding: computerText(request.desktopBinding),
    expectedGeometry: readPhysicalRectangle(request.expectedGeometry)
  };
}
function readNativeComputerResult(value) {
  const result = computerRecord(value);
  computerFields(result, [
    "desktop",
    "windows",
    "focusedWindow",
    "observation",
    "dispatch",
    "error"
  ]);
  if (Buffer.byteLength(JSON.stringify(value)) > 96 * 1024)
    return computerInputError("Desktop metadata exceeds its limit.");
  const desktop = computerRecord(result.desktop);
  if (!["windows", "macos", "linux"].includes(String(desktop.platform)))
    return computerInputError("Invalid desktop platform.");
  computerText(desktop.binding);
  computerText(desktop.name);
  if (desktop.reason !== void 0) computerText(desktop.reason);
  if (desktop.coordinateSpace !== void 0 && !["physical_pixels", "logical_points"].includes(
    String(desktop.coordinateSpace)
  ))
    return computerInputError("Invalid desktop coordinate space.");
  if (typeof desktop.available !== "boolean")
    return computerInputError("Invalid desktop availability.");
  readPhysicalRectangle(desktop.bounds);
  if (!["verified_window", "observed_surface"].includes(
    String(desktop.targetingGuarantee)
  ))
    return computerInputError("Invalid targeting guarantee.");
  const capabilities = computerRecord(desktop.capabilities);
  for (const kind of ["capture", "accessibility", "input", "windows"]) {
    const capability = computerRecord(capabilities[kind]);
    if (capability.reason !== void 0) computerText(capability.reason);
    if (typeof capability.supported !== "boolean" || typeof capability.available !== "boolean")
      return computerInputError("Invalid desktop capability.");
  }
  if (!Array.isArray(result.windows) || result.windows.length > 256)
    return computerInputError("Invalid window list.");
  for (const raw of result.windows) {
    const window = computerRecord(raw);
    computerText(window.binding);
    computerText(window.title);
    if (window.application !== void 0) computerText(window.application);
    readPhysicalRectangle(window.bounds);
    if (typeof window.focused !== "boolean")
      return computerInputError("Invalid window focus.");
  }
  if (result.focusedWindow !== void 0) computerText(result.focusedWindow);
  if (result.observation !== void 0) validateObservation(result.observation);
  if (result.dispatch !== void 0) {
    const dispatch = computerRecord(result.dispatch);
    if (!["not_dispatched", "accepted", "partial", "unknown"].includes(
      String(dispatch.status)
    ))
      return computerInputError("Invalid input dispatch status.");
    readInputCount(dispatch.requestedInputCount);
    if (dispatch.acceptedInputCount !== void 0)
      readInputCount(dispatch.acceptedInputCount);
    if (dispatch.reason !== void 0) computerText(dispatch.reason);
  }
  if (result.error !== void 0) {
    const error = computerRecord(result.error);
    computerText(error.code, 128);
    computerText(error.message);
  }
  return value;
}
function readInputCount(value) {
  const count = computerNumber(value, 0, 1e5);
  if (!Number.isInteger(count))
    return computerInputError("Invalid input event count.");
  return count;
}
function validateObservation(value) {
  const observation = computerRecord(value);
  computerText(observation.capturedAt, 128);
  readPhysicalRectangle(observation.region);
  computerNumber(observation.imageWidth, 1, 65536);
  computerNumber(observation.imageHeight, 1, 65536);
  if (!Array.isArray(observation.accessibility) || observation.accessibility.length > 512)
    return computerInputError("Invalid accessibility observation.");
  if (typeof observation.accessibilityTruncated !== "boolean")
    return computerInputError("Invalid accessibility coverage.");
  for (const raw of observation.accessibility) {
    const node = computerRecord(raw);
    computerText(node.role, 128);
    if (node.name !== void 0) computerText(node.name);
    if (node.value !== void 0) computerText(node.value);
    if (node.bounds !== void 0) readPhysicalRectangle(node.bounds);
  }
}

// src/computer-access/computer/companion-backend.ts
function createCompanionComputerBackend(rootDir, route, connection) {
  const sessionId = (0, import_node_crypto4.randomUUID)();
  let closed = false;
  const call = async (operation, params, signal) => {
    const result = await connection.executeHostOperation(rootDir, {
      hostId: route.hostId,
      connectionId: route.connectionId,
      operation,
      params: { ...params, sessionId, target: route.target },
      ...signal ? { abortSignal: signal } : {}
    });
    if (!result.ok)
      throw new SystemOperationError(
        result.errorCode ?? "computer_host_failed",
        result.output
      );
    return computerRecord(result.data);
  };
  return {
    async execute(request, signal) {
      if (closed)
        throw new SystemOperationError(
          "computer_session_closed",
          "The desktop session has closed."
        );
      const response = await call("computer_execute", { request }, signal);
      const result = readNativeComputerResult(response.result);
      if (response.frame === void 0) return result;
      let bytes;
      try {
        const frame = computerRecord(response.frame);
        const id = computerText(frame.id, 128);
        const size = computerNumber(frame.size, 1, COMPUTER_IMAGE_MAX_BYTES);
        if (!Number.isInteger(size))
          throw new Error("computer_frame_size_invalid");
        const hash = computerText(frame.sha256, 64);
        bytes = Buffer.alloc(size);
        for (let offset = 0; offset < size; offset += COMPUTER_FRAME_CHUNK_BYTES) {
          const chunk = await call(
            "computer_frame",
            { frameId: id, offset },
            signal
          );
          const encoded = computerText(
            chunk.bytes,
            COMPUTER_FRAME_CHUNK_BYTES * 2
          );
          const decoded = Buffer.from(encoded, "base64");
          if (decoded.length !== Math.min(COMPUTER_FRAME_CHUNK_BYTES, size - offset))
            throw new Error("computer_frame_chunk_invalid");
          decoded.copy(bytes, offset);
          decoded.fill(0);
        }
        if ((0, import_node_crypto4.createHash)("sha256").update(bytes).digest("hex") !== hash)
          throw new Error("computer_frame_digest_invalid");
        return { ...result, image: { mimeType: "image/png", bytes } };
      } catch (error) {
        bytes?.fill(0);
        if (result.dispatch)
          return {
            ...result,
            error: {
              code: "computer_frame_transfer_failed",
              message: "Input receipt is preserved; the resulting image could not be transferred. Observe again before another action."
            }
          };
        throw error;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      const deadline = AbortSignal.timeout(3e3);
      await call("computer_close", {}, deadline).catch(() => void 0);
    }
  };
}

// src/computer-access/computer/desktop-action-queue.ts
var desktopTails = /* @__PURE__ */ new Map();
async function withDesktopQueue(identity, signal, operation) {
  signal?.throwIfAborted();
  const previous = desktopTails.get(identity) ?? Promise.resolve();
  let release2;
  const done = new Promise((resolve) => {
    release2 = resolve;
  });
  const tail = previous.then(() => done);
  desktopTails.set(identity, tail);
  try {
    await waitForDesktopTurn(previous, signal);
    signal?.throwIfAborted();
    return await operation();
  } finally {
    release2();
    void tail.then(() => {
      if (desktopTails.get(identity) === tail) desktopTails.delete(identity);
    });
  }
}
function waitForDesktopTurn(previous, signal) {
  if (!signal) return previous;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    void previous.then(() => {
      cleanup();
      resolve();
    });
  });
}

// src/computer-access/computer/windows-helper-process.ts
var import_node_child_process = require("node:child_process");
var WINDOWS_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
var WINDOWS_HELPER_MAX_BYTES = Math.ceil(WINDOWS_IMAGE_MAX_BYTES / 3) * 4 + 256 * 1024;
var HELPER_BOOTSTRAP = [
  "$ErrorActionPreference='Stop'",
  "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)",
  "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
  "try {",
  "$envelope=[Console]::In.ReadToEnd() | ConvertFrom-Json",
  "Add-Type -ReferencedAssemblies @('System.Drawing','UIAutomationClient','UIAutomationTypes','WindowsBase','System.Web.Extensions') -TypeDefinition $envelope.source",
  "[Console]::WriteLine([AbotComputer]::Run($envelope.request))",
  `} catch { [Console]::WriteLine('{"transportError":"windows_helper_unavailable"}'); exit 1 }`
].join(";");
function runWindowsComputerHelper(input) {
  if (input.signal?.aborted)
    return Promise.resolve({ status: "aborted", stdout: "", spawned: false });
  const payload = JSON.stringify({ source: input.source, request: JSON.stringify(input.request) });
  if (Buffer.byteLength(payload) > 512 * 1024)
    return Promise.resolve({ status: "output_limit", stdout: "", spawned: false });
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let spawned = false;
    let status = "completed";
    let bytes = 0;
    const chunks = [];
    let timeout;
    let stopGrace;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (stopGrace) clearTimeout(stopGrace);
      input.signal?.removeEventListener("abort", abort);
      resolve({
        status,
        stdout: status === "completed" ? Buffer.concat(chunks).toString("utf8") : "",
        spawned,
        ...exitCode !== void 0 ? { exitCode } : {}
      });
    };
    const stop = (reason) => {
      if (settled || status !== "completed") return;
      status = reason;
      chunks.length = 0;
      child.kill("SIGKILL");
      stopGrace = setTimeout(() => finish(), 500);
      stopGrace.unref();
    };
    const abort = () => stop("aborted");
    try {
      child = (input.spawnProcess ?? import_node_child_process.spawn)(
        input.executable,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", HELPER_BOOTSTRAP],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
      );
    } catch {
      status = "spawn_failed";
      finish();
      return;
    }
    child.once("spawn", () => {
      spawned = true;
    });
    child.once("error", () => {
      status = "spawn_failed";
      finish();
    });
    child.once("close", (code) => finish(code ?? void 0));
    child.stdout.on("data", (chunk) => {
      if (settled || status !== "completed") return;
      bytes += chunk.length;
      if (bytes > WINDOWS_HELPER_MAX_BYTES) {
        stop("output_limit");
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    child.stderr.resume();
    child.stdin.on("error", () => stop("spawn_failed"));
    const deadline = input.request.operation === "act" ? input.request.deadlineEpochMs - Date.now() + 2e3 : 25e3;
    timeout = setTimeout(() => stop("timeout"), Math.max(1, Math.min(deadline, 3e4)));
    timeout.unref();
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) {
      abort();
      return;
    }
    child.stdin.end(payload, "utf8");
  });
}

// src/computer-access/computer/windows-accessibility-script.ts
var WINDOWS_ACCESSIBILITY_SCRIPT = String.raw`
public static partial class AbotComputer {
  static AutomationElement FocusedDocument(AutomationElement root) {
    try {
      var item=AutomationElement.FocusedElement;
      AutomationElement document=null;
      for(int depth=0;depth<64 && item!=null;depth++) {
        if(item.Equals(root)) return document;
        if(item.Current.ControlType==ControlType.Document) document=item;
        item=TreeWalker.ControlViewWalker.GetParent(item);
      }
    } catch {}
    return null;
  }
  static bool HasVisibleIntersection(System.Windows.Rect bounds,Rect region) {
    if(bounds.IsEmpty || bounds.Width<1 || bounds.Height<1) return false;
    if(Double.IsInfinity(bounds.X) || Double.IsInfinity(bounds.Y)) return false;
    if(bounds.Right<=region.Left || bounds.Bottom<=region.Top) return false;
    return bounds.Left<region.Right && bounds.Top<region.Bottom;
  }
  static string BoundedText(string text,int maximum) {
    if(text==null) return "";
    return text.Length<=maximum?text:text.Substring(0,maximum);
  }
  static Dictionary<string,object> AccessibilityNode(AutomationElement element,bool leaf,Rect region) {
    var current=element.Current;
    if(current.IsOffscreen || current.IsPassword) return null;
    var bounds=current.BoundingRectangle;
    if(!HasVisibleIntersection(bounds,region)) return null;
    var node=Obj("role",current.ControlType.ProgrammaticName.Replace("ControlType.",""),
      "name",BoundedText(current.Name,512),"focused",current.HasKeyboardFocus,
      "bounds",Rectangle((int)Math.Round(bounds.X),(int)Math.Round(bounds.Y),
        Math.Max(1,(int)Math.Round(bounds.Width)),Math.Max(1,(int)Math.Round(bounds.Height))));
    // Parent text/value patterns can include invisible or protected descendants.
    if(!leaf) return node;
    object pattern;
    if(element.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)) {
      node["value"]=BoundedText(((ValuePattern)pattern).Current.Value,2048);
      return node;
    }
    if(!element.TryGetCurrentPattern(TextPattern.Pattern,out pattern)) return node;
    var parts=new List<string>(); int remaining=2048;
    foreach(var range in ((TextPattern)pattern).GetVisibleRanges()) {
      if(remaining<=0) break;
      string text=range.GetText(remaining);
      parts.Add(text); remaining-=text.Length;
    }
    node["value"]=BoundedText(String.Join("\n",parts.ToArray()),2048);
    return node;
  }
  static List<object> ReadAccessibility(Rect region,out bool truncated) {
    var nodes=new List<object>(); truncated=true;
    try {
      IntPtr foreground=GetForegroundWindow();
      if(foreground==IntPtr.Zero) return nodes;
      var root=AutomationElement.FromHandle(foreground);
      var document=FocusedDocument(root);
      var queue=new Queue<AutomationElement>(); queue.Enqueue(document ?? root);
      var walker=TreeWalker.ControlViewWalker;
      var watch=Stopwatch.StartNew(); int visited=0,bytes=0;
      while(queue.Count>0 && nodes.Count<128 && visited<600 && watch.ElapsedMilliseconds<500) {
        var element=queue.Dequeue(); visited++;
        try {
          if(element.Current.IsPassword || element.Current.IsOffscreen) continue;
          if(document==null && element.Current.ControlType==ControlType.Document) continue;
          var child=walker.GetFirstChild(element);
          var node=AccessibilityNode(element,child==null,region);
          if(node!=null) {
            int nodeBytes=Encoding.UTF8.GetByteCount(Json.Serialize(node));
            if(bytes+nodeBytes>32768) return nodes;
            nodes.Add(node); bytes+=nodeBytes;
          }
          int siblings=0;
          while(child!=null && siblings<600 && queue.Count<600 && watch.ElapsedMilliseconds<500) {
            queue.Enqueue(child); siblings++; child=walker.GetNextSibling(child);
          }
        } catch(ElementNotAvailableException) {}
        catch(InvalidOperationException) {}
      }
      // Visible UIA is a subset of pixels even when its bounded traversal exhausted the queue.
      truncated=true;
    } catch {}
    return nodes;
  }
}
`;

// src/computer-access/computer/windows-capture-script.ts
var WINDOWS_CAPTURE_SCRIPT = String.raw`
public static partial class AbotComputer {
  static void RequireObservationSource(Dictionary<string,object> request,Dictionary<string,object> result) {
    if(Field(request,"region")==null && Field(request,"operation") as string!="act") return;
    var desktop=Record(result["desktop"]);
    if(Text(request,"desktopBinding",4096)!=(string)desktop["binding"])
      throw new ComputerFault("computer_desktop_stale","The capture belongs to a different desktop observation.");
    if(!SameRectangle(ParseRectangle(request["expectedGeometry"]),ParseRectangle(desktop["bounds"])))
      throw new ComputerFault("computer_geometry_changed","The display geometry changed before capture.");
  }
  static void CaptureObservation(Dictionary<string,object> result,object requestedRegion) {
    RequireAvailableDesktop(result);
    var desktop=Record(result["desktop"]);
    string binding=(string)desktop["binding"];
    Rect virtualBounds=ParseRectangle(desktop["bounds"]);
    Rect region=requestedRegion==null?virtualBounds:ParseRectangle(requestedRegion);
    if(!ContainsRectangle(virtualBounds,region))
      throw new ComputerFault("computer_region_outside_desktop","The requested region is outside the physical desktop.");
    int width=region.Right-region.Left,height=region.Bottom-region.Top;
    if((long)width*height>64000000)
      throw new ComputerFault("computer_capture_too_large","Select a smaller physical capture region.");
    string foreground=NativeWindowBinding(GetForegroundWindow());
    if(!Object.Equals(Field(result,"focusedWindow"),foreground))
      throw new ComputerFault("computer_focus_changed","Focus changed before capture; obtain a fresh observation.");
    VerifyDesktopBinding(binding);
    int imageWidth,imageHeight;
    byte[] image=CapturePixels(region,out imageWidth,out imageHeight);
    bool truncated;
    var accessibility=ReadAccessibility(region,out truncated);
    VerifyDesktopBinding(binding);
    if(!SameRectangle(VirtualDesktopBounds(),virtualBounds))
      throw new ComputerFault("computer_geometry_changed","The display geometry changed during observation.");
    if(NativeWindowBinding(GetForegroundWindow())!=foreground)
      throw new ComputerFault("computer_focus_changed","Focus changed during observation; obtain a fresh observation.");
    result["observation"]=Obj("capturedAt",DateTime.UtcNow.ToString("o"),
      "region",Rectangle(region.Left,region.Top,width,height),"imageWidth",imageWidth,"imageHeight",imageHeight,
      "accessibility",accessibility,"accessibilityTruncated",truncated);
    result["image"]=Obj("mimeType","image/png","base64",Convert.ToBase64String(image));
  }
  static byte[] CapturePixels(Rect region,out int imageWidth,out int imageHeight) {
    int width=region.Right-region.Left,height=region.Bottom-region.Top;
    using(var original=new Bitmap(width,height,PixelFormat.Format32bppArgb)) {
      using(var graphics=Graphics.FromImage(original)) {
        graphics.CopyFromScreen(region.Left,region.Top,0,0,new Size(width,height),CopyPixelOperation.SourceCopy);
      }
      int maxDimension=2048;
      while(maxDimension>=256) {
        double scale=Math.Min(1.0,(double)maxDimension/Math.Max(width,height));
        imageWidth=Math.Max(1,(int)Math.Round(width*scale));
        imageHeight=Math.Max(1,(int)Math.Round(height*scale));
        using(var resized=new Bitmap(imageWidth,imageHeight,PixelFormat.Format32bppArgb)) {
          using(var graphics=Graphics.FromImage(resized)) {
            graphics.InterpolationMode=System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
            graphics.DrawImage(original,0,0,imageWidth,imageHeight);
          }
          using(var stream=new MemoryStream()) {
            resized.Save(stream,ImageFormat.Png);
            if(stream.Length<=ImageMaxBytes) return stream.ToArray();
          }
        }
        maxDimension/=2;
      }
    }
    imageWidth=0; imageHeight=0;
    throw new ComputerFault("computer_capture_too_large","The screenshot exceeds the image byte limit.");
  }
}
`;

// src/computer-access/computer/windows-desktop-script.ts
var WINDOWS_DESKTOP_SCRIPT = String.raw`
public static partial class AbotComputer {
  static Dictionary<string,object> Capability(bool available,string reason) {
    var result=Obj("supported",true,"available",available);
    if(!String.IsNullOrEmpty(reason)) result["reason"]=reason;
    return result;
  }
  static Dictionary<string,object> UnavailableResult(string reason) {
    return Obj("desktop",Obj("platform","windows","binding","windows:unavailable",
      "name","Windows desktop","available",false,"reason",reason,"bounds",Rectangle(0,0,1,1),
      "capabilities",Obj("capture",Capability(false,reason),"accessibility",Capability(false,reason),
        "input",Capability(false,reason),"windows",Capability(false,reason)),
      "targetingGuarantee","observed_surface"),"windows",new object[0]);
  }
  static string NativeLogonIdentity() {
    IntPtr token;
    if(!OpenProcessToken(Process.GetCurrentProcess().Handle,0x0008,out token)) return null;
    try {
      TokenStatistics information; int needed;
      if(!GetTokenInformation(token,10,out information,Marshal.SizeOf(typeof(TokenStatistics)),out needed)) return null;
      return information.AuthenticationId.High.ToString("X8")+information.AuthenticationId.Low.ToString("X8");
    } finally { CloseHandle(token); }
  }
  static string InputDesktopName() {
    IntPtr desktop=OpenInputDesktop(0,false,0x0001);
    if(desktop==IntPtr.Zero) return null;
    try {
      var name=new StringBuilder(128); int needed;
      if(!GetUserObjectInformation(desktop,2,name,name.Capacity*2,out needed)) return null;
      return name.ToString();
    } finally { CloseDesktop(desktop); }
  }
  static Rect VirtualDesktopBounds() {
    int x=GetSystemMetrics(76),y=GetSystemMetrics(77);
    return new Rect { Left=x,Top=y,Right=x+GetSystemMetrics(78),Bottom=y+GetSystemMetrics(79) };
  }
  static string ReadDesktopBinding(out string reason) {
    reason=null;
    int session=Process.GetCurrentProcess().SessionId;
    if(session==0) { reason="interactive_session_unavailable"; return null; }
    string desktop=InputDesktopName();
    if(desktop!="Default") { reason="screen_locked_or_secure_desktop"; return null; }
    string logon=NativeLogonIdentity();
    if(logon==null) { reason="login_identity_unavailable"; return null; }
    string topology;
    try { topology=ReadCaptureTopology(); }
    catch(ComputerFault fault) { reason=fault.Code; return null; }
    return "windows:"+Environment.MachineName+":"+session+":"+logon+":"+desktop+":"+topology;
  }
  static string NativeWindowBinding(IntPtr window) {
    if(window==IntPtr.Zero || !IsWindow(window)) return null;
    uint processId; GetWindowThreadProcessId(window,out processId);
    if(processId==0) return null;
    try {
      using(var process=Process.GetProcessById((int)processId)) {
        return window.ToInt64().ToString("X")+":"+processId+":"+process.StartTime.ToUniversalTime().Ticks;
      }
    } catch { return null; }
  }
  static IntPtr ResolveWindowBinding(string binding) {
    string[] parts=binding.Split(':'); long handle;
    if(parts.Length!=3 || !Int64.TryParse(parts[0],System.Globalization.NumberStyles.HexNumber,
      System.Globalization.CultureInfo.InvariantCulture,out handle))
      throw new ComputerFault("computer_window_stale","The window reference is invalid.");
    var window=new IntPtr(handle);
    if(NativeWindowBinding(window)!=binding)
      throw new ComputerFault("computer_window_stale","The selected native window no longer exists.");
    return window;
  }
  static Dictionary<string,object> ReadWindow(IntPtr window,IntPtr foreground) {
    if(!IsWindowVisible(window)) return null;
    string binding=NativeWindowBinding(window);
    if(binding==null) return null;
    Rect bounds;
    if(!GetWindowRect(window,out bounds)) return null;
    if(bounds.Right<=bounds.Left || bounds.Bottom<=bounds.Top) return null;
    var title=new StringBuilder(513); GetWindowText(window,title,title.Capacity);
    var result=Obj("binding",binding,"title",title.ToString(),
      "bounds",Rectangle(bounds.Left,bounds.Top,bounds.Right-bounds.Left,bounds.Bottom-bounds.Top),
      "focused",window==foreground);
    try {
      uint processId; GetWindowThreadProcessId(window,out processId);
      using(var process=Process.GetProcessById((int)processId)) result["application"]=process.ProcessName;
    } catch {}
    return result;
  }
  static Dictionary<string,object> DesktopSnapshot() {
    string reason; string binding=ReadDesktopBinding(out reason);
    if(binding==null) return UnavailableResult(reason);
    Rect bounds=VirtualDesktopBounds();
    if(bounds.Right<=bounds.Left || bounds.Bottom<=bounds.Top) return UnavailableResult("desktop_geometry_unavailable");
    IntPtr foreground=GetForegroundWindow();
    string focused=NativeWindowBinding(foreground);
    var windows=new List<object>(); int windowBytes=0;
    // Capture the foreground first so bounded enumeration cannot omit the selected source.
    var active=ReadWindow(foreground,foreground);
    if(active!=null) { windows.Add(active); windowBytes=Encoding.UTF8.GetByteCount(Json.Serialize(active)); }
    EnumWindowCallback callback=(window,parameter)=> {
      if(window==foreground) return true;
      if(windows.Count>=128 || windowBytes>=32768) return false;
      var value=ReadWindow(window,foreground);
      if(value==null) return true;
      int bytes=Encoding.UTF8.GetByteCount(Json.Serialize(value));
      if(windowBytes+bytes>32768) return false;
      windows.Add(value); windowBytes+=bytes; return true;
    };
    EnumWindows(callback,IntPtr.Zero);
    var result=Obj("desktop",Obj("platform","windows","binding",binding,
      "name",Environment.MachineName+" / Windows desktop","available",true,
      "bounds",Rectangle(bounds.Left,bounds.Top,bounds.Right-bounds.Left,bounds.Bottom-bounds.Top),
      "capabilities",Obj("capture",Capability(true,null),"accessibility",Capability(true,"visible_accessibility_subset"),
        "input",Capability(true,"uipi_may_restrict_input"),"windows",Capability(true,"window_enumeration_bounded")),
      "targetingGuarantee",focused==null?"observed_surface":"verified_window"),"windows",windows);
    if(focused!=null) result["focusedWindow"]=focused;
    return result;
  }
  static void RequireAvailableDesktop(Dictionary<string,object> result) {
    var desktop=Record(result["desktop"]);
    if(!Object.Equals(Field(desktop,"available"),true))
      throw new ComputerFault("computer_desktop_unavailable","The interactive desktop is unavailable or locked.");
  }
  static void VerifyDesktopBinding(string expected) {
    string reason;
    if(ReadDesktopBinding(out reason)!=expected)
      throw new ComputerFault("computer_desktop_changed","The login or interactive desktop changed.");
  }
}
`;

// src/computer-access/computer/windows-input-script.ts
var WINDOWS_INPUT_SCRIPT = String.raw`
public static partial class AbotComputer {
  [StructLayout(LayoutKind.Sequential)] struct MouseInput {
    public int X,Y; public uint Data,Flags,Time; public UIntPtr Extra;
  }
  [StructLayout(LayoutKind.Sequential)] struct KeyboardInput {
    public ushort Key,Scan; public uint Flags,Time; public UIntPtr Extra;
  }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion {
    [FieldOffset(0)] public MouseInput Mouse;
    [FieldOffset(0)] public KeyboardInput Keyboard;
  }
  [StructLayout(LayoutKind.Sequential)] struct NativeInput { public uint Type; public InputUnion Data; }
  [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,NativeInput[] inputs,int size);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(Point point,uint flags);

  sealed class DispatchState {
    public int Requested,Accepted; public bool Started,Uncertain; public string Failure;
    public void Fail(Exception error) {
      var fault=error as ComputerFault; Failure=fault==null?"native_action_failed":fault.Code;
    }
    public Dictionary<string,object> Result() {
      string status="not_dispatched";
      if(Started && Accepted>0) status=Failure==null && Accepted==Requested?"accepted":"partial";
      if(Uncertain) status="unknown";
      var result=Obj("status",status,"requestedInputCount",Requested,"acceptedInputCount",Accepted);
      if(Failure!=null) result["reason"]=Failure;
      return result;
    }
    public void Send(NativeInput[] inputs) {
      if(inputs.Length==0) return;
      Started=true; Requested+=inputs.Length;
      uint accepted=SendInput((uint)inputs.Length,inputs,Marshal.SizeOf(typeof(NativeInput)));
      Accepted+=(int)accepted;
      if(accepted!=(uint)inputs.Length)
        throw new ComputerFault("computer_input_not_accepted","Windows accepted only part or none of the input; UIPI or desktop state may restrict injection.");
    }
    public void Cleanup(NativeInput[] inputs) {
      try { Send(inputs); } catch(Exception error) { Fail(error); }
    }
  }
  static void VerifyActionPreconditions(Dictionary<string,object> request,Dictionary<string,object> result) {
    RequireAvailableDesktop(result);
    string binding=Text(request,"desktopBinding",4096);
    if((string)Record(result["desktop"])["binding"]!=binding)
      throw new ComputerFault("computer_desktop_changed","The action belongs to a different desktop observation.");
    if(!SameRectangle(ParseRectangle(request["expectedGeometry"]),VirtualDesktopBounds()))
      throw new ComputerFault("computer_geometry_changed","The display geometry changed before input dispatch.");
    string expected=Field(request,"expectedWindow") as string;
    if(expected!=null && NativeWindowBinding(GetForegroundWindow())!=expected)
      throw new ComputerFault("computer_focus_changed","The focused window changed before input dispatch.");
    VerifyActionLease(request);
  }
  static void VerifyActionLease(Dictionary<string,object> request) {
    if(HasExpiredAction(request))
      throw new ComputerFault("computer_action_expired","The action deadline passed; no remaining input will be sent.");
    VerifyDesktopBinding(Text(request,"desktopBinding",4096));
    if(!SameRectangle(ParseRectangle(request["expectedGeometry"]),VirtualDesktopBounds()))
      throw new ComputerFault("computer_geometry_changed","The display geometry changed during input dispatch.");
  }
  static void VerifyInitialInputBinding(Dictionary<string,object> request) {
    VerifyActionLease(request);
    string expected=Field(request,"expectedWindow") as string;
    if(expected!=null && NativeWindowBinding(GetForegroundWindow())!=expected)
      throw new ComputerFault("computer_focus_changed","The focused window changed before input dispatch.");
  }
  static Point InputPoint(object raw) {
    var point=Record(raw);
    double x=Number(point,"x"),y=Number(point,"y");
    if(x< -131072 || x>131072 || y< -131072 || y>131072)
      throw new ComputerFault("computer_point_invalid","Input coordinates exceed the physical desktop range.");
    var result=new Point { X=(int)Math.Round(x),Y=(int)Math.Round(y) };
    Rect bounds=VirtualDesktopBounds();
    if(result.X<bounds.Left || result.X>=bounds.Right || result.Y<bounds.Top || result.Y>=bounds.Bottom)
      throw new ComputerFault("computer_point_invalid","Input coordinates are outside the physical desktop.");
    if(MonitorFromPoint(result,0)==IntPtr.Zero)
      throw new ComputerFault("computer_point_invalid","Input coordinates are in a gap between displays.");
    return result;
  }
  static NativeInput Mouse(uint flags,int x,int y,uint data) {
    return new NativeInput { Type=0,Data=new InputUnion { Mouse=new MouseInput { X=x,Y=y,Data=data,Flags=flags } } };
  }
  static NativeInput MoveInput(Point point) {
    Rect bounds=VirtualDesktopBounds();
    int x=(int)Math.Round((double)(point.X-bounds.Left)*65535/Math.Max(1,bounds.Right-bounds.Left-1));
    int y=(int)Math.Round((double)(point.Y-bounds.Top)*65535/Math.Max(1,bounds.Bottom-bounds.Top-1));
    return Mouse(0x0001|0x8000|0x4000,x,y,0);
  }
  static uint ButtonFlag(string button,bool up) {
    if(button=="left") return up?0x0004u:0x0002u;
    if(button=="right") return up?0x0010u:0x0008u;
    if(button=="middle") return up?0x0040u:0x0020u;
    throw new ComputerFault("computer_request_invalid","Unknown pointer button.");
  }
  static void RequireNoHeldInput() {
    foreach(int key in new int[] {1,2,4,16,17,18,91,92}) {
      if((GetAsyncKeyState(key)&0x8000)!=0)
        throw new ComputerFault("computer_user_input_active","A pointer button or modifier is already held; wait for a fresh observation.");
    }
  }
  static void Act(Dictionary<string,object> request,Dictionary<string,object> result,DispatchState dispatch) {
    VerifyActionPreconditions(request,result);
    var action=Record(Field(request,"action")); string kind=Text(action,"kind",32);
    if(kind=="focus_window") { FocusWindow(action,request,dispatch); return; }
    RequireNoHeldInput();
    if(kind=="press_keys") { PressKeys(action,request,dispatch); return; }
    if(kind=="type_text") { TypeText(action,request,dispatch); return; }
    if(kind=="drag") { Drag(action,request,dispatch); return; }
    if(kind=="scroll") { Scroll(action,request,dispatch); return; }
    if(kind=="move") {
      var move=MoveInput(InputPoint(Field(action,"point"))); VerifyActionPreconditions(request,result);
      dispatch.Send(new NativeInput[] {move}); return;
    }
    if(kind!="click") throw new ComputerFault("computer_request_invalid","Unknown native input operation.");
    var point=InputPoint(Field(action,"point")); string button=Text(action,"button",16);
    int count=Integer(action,"count",1,2); uint down=ButtonFlag(button,false),up=ButtonFlag(button,true);
    var inputs=new List<NativeInput>(); inputs.Add(MoveInput(point));
    for(int i=0;i<count;i++) { inputs.Add(Mouse(down,0,0,0)); inputs.Add(Mouse(up,0,0,0)); }
    VerifyActionPreconditions(request,result);
    try { dispatch.Send(inputs.ToArray()); }
    catch { dispatch.Cleanup(new NativeInput[] {Mouse(up,0,0,0)}); throw; }
  }
  static void FocusWindow(Dictionary<string,object> action,Dictionary<string,object> request,DispatchState dispatch) {
    IntPtr window=ResolveWindowBinding(Text(action,"windowBinding",4096));
    VerifyInitialInputBinding(request);
    if(IsIconic(window)) {
      dispatch.Requested++; dispatch.Started=true; dispatch.Uncertain=true;
      ShowWindow(window,9);
      if(IsIconic(window)) throw new ComputerFault("computer_window_restore_unconfirmed","The restore request could not be confirmed.");
      dispatch.Accepted++; dispatch.Uncertain=false;
    }
    // Restore may itself have changed focus; only enforce the binding before that effect.
    VerifyActionLease(request);
    dispatch.Requested++; dispatch.Started=true; dispatch.Uncertain=true;
    SetForegroundWindow(window);
    if(GetForegroundWindow()!=window)
      throw new ComputerFault("computer_focus_not_granted","Windows did not confirm focus on the selected window.");
    dispatch.Accepted++; dispatch.Uncertain=false;
  }
  static void Scroll(Dictionary<string,object> action,Dictionary<string,object> request,DispatchState dispatch) {
    int x=(int)Math.Round(Number(action,"deltaX")),y=(int)Math.Round(Number(action,"deltaY"));
    if(Math.Abs((long)x)>5000 || Math.Abs((long)y)>5000)
      throw new ComputerFault("computer_request_invalid","Scroll delta is out of range.");
    var inputs=new List<NativeInput>();
    if(x!=0) inputs.Add(Mouse(0x1000,0,0,unchecked((uint)x)));
    // Public deltas use positive-down screen coordinates; Windows wheel uses positive-up.
    if(y!=0) inputs.Add(Mouse(0x0800,0,0,unchecked((uint)-y)));
    VerifyInitialInputBinding(request); dispatch.Send(inputs.ToArray());
  }
  static void Drag(Dictionary<string,object> action,Dictionary<string,object> request,DispatchState dispatch) {
    Point from=InputPoint(Field(action,"from")),to=InputPoint(Field(action,"to"));
    int duration=PhysicalPixel(action,"durationMs",0,5000); string button=Text(action,"button",16);
    uint down=ButtonFlag(button,false),up=ButtonFlag(button,true);
    int steps=Math.Max(1,Math.Min(100,duration/16)); bool pressed=false;
    try {
      VerifyInitialInputBinding(request); pressed=true;
      dispatch.Send(new NativeInput[] {MoveInput(from),Mouse(down,0,0,0)});
      string active=NativeWindowBinding(GetForegroundWindow());
      for(int i=1;i<=steps;i++) {
        if(duration>0) Thread.Sleep(duration/steps);
        VerifyActionLease(request);
        if(NativeWindowBinding(GetForegroundWindow())!=active)
          throw new ComputerFault("computer_focus_changed","Focus changed during the drag.");
        var point=new Point {X=from.X+(int)Math.Round((double)(to.X-from.X)*i/steps),Y=from.Y+(int)Math.Round((double)(to.Y-from.Y)*i/steps)};
        dispatch.Send(new NativeInput[] {MoveInput(point)});
      }
    } finally { if(pressed) dispatch.Cleanup(new NativeInput[] {Mouse(up,0,0,0)}); }
  }
}
`;

// src/computer-access/computer/windows-keyboard-script.ts
var WINDOWS_KEYBOARD_SCRIPT = String.raw`
public static partial class AbotComputer {
  static ushort VirtualKey(string name) {
    string key=name.Trim().ToUpperInvariant();
    if(key.Length==1 && ((key[0]>='A' && key[0]<='Z') || (key[0]>='0' && key[0]<='9'))) return key[0];
    int function;
    if(key.StartsWith("F") && Int32.TryParse(key.Substring(1),out function) && function>=1 && function<=24)
      return (ushort)(111+function);
    switch(key) {
      case "CONTROL": case "CTRL": return 17;
      case "ALT": case "OPTION": return 18;
      case "SHIFT": return 16;
      case "META": case "WIN": case "WINDOWS": case "SUPER": return 91;
      case "ENTER": case "RETURN": return 13;
      case "TAB": return 9;
      case "ESC": case "ESCAPE": return 27;
      case "BACKSPACE": return 8;
      case "DELETE": case "DEL": return 46;
      case "SPACE": return 32;
      case "LEFT": case "ARROWLEFT": return 37;
      case "UP": case "ARROWUP": return 38;
      case "RIGHT": case "ARROWRIGHT": return 39;
      case "DOWN": case "ARROWDOWN": return 40;
      case "HOME": return 36;
      case "END": return 35;
      case "PAGEUP": case "PGUP": return 33;
      case "PAGEDOWN": case "PGDN": return 34;
      case "INSERT": case "INS": return 45;
      case "CAPSLOCK": return 20;
      case "PRINTSCREEN": return 44;
      default: throw new ComputerFault("computer_key_unsupported","Use explicit supported key names; text belongs in type_text.");
    }
  }
  static bool IsExtendedKey(ushort key) {
    if(key>=33 && key<=46) return true;
    return key==91;
  }
  static NativeInput Key(ushort key,ushort scan,uint flags) {
    return new NativeInput {Type=1,Data=new InputUnion {Keyboard=new KeyboardInput {Key=key,Scan=scan,Flags=flags}}};
  }
  static void PressKeys(Dictionary<string,object> action,Dictionary<string,object> request,DispatchState dispatch) {
    var raw=Field(action,"keys") as object[];
    if(raw==null || raw.Length<1 || raw.Length>8)
      throw new ComputerFault("computer_request_invalid","Use one to eight explicit keys.");
    var keys=new List<ushort>(); var seen=new HashSet<ushort>();
    foreach(object value in raw) {
      var text=value as string;
      if(text==null || text.Length>32) throw new ComputerFault("computer_request_invalid","Invalid key name.");
      ushort key=VirtualKey(text);
      if(!seen.Add(key)) throw new ComputerFault("computer_request_invalid","A chord cannot repeat the same key.");
      if((GetAsyncKeyState(key)&0x8000)!=0)
        throw new ComputerFault("computer_user_input_active","A requested key is already physically held.");
      keys.Add(key);
    }
    var inputs=new List<NativeInput>(); var releases=new List<NativeInput>();
    foreach(ushort key in keys) inputs.Add(Key(key,0,IsExtendedKey(key)?1u:0u));
    for(int i=keys.Count-1;i>=0;i--) releases.Add(Key(keys[i],0,2u|(IsExtendedKey(keys[i])?1u:0u)));
    inputs.AddRange(releases); VerifyInitialInputBinding(request);
    try { dispatch.Send(inputs.ToArray()); }
    catch { dispatch.Cleanup(releases.ToArray()); throw; }
  }
  static void TypeText(Dictionary<string,object> action,Dictionary<string,object> request,DispatchState dispatch) {
    string text=Text(action,"text",4096);
    VerifyInitialInputBinding(request);
    string foreground=NativeWindowBinding(GetForegroundWindow());
    for(int start=0;start<text.Length;start+=128) {
      VerifyActionLease(request);
      if(NativeWindowBinding(GetForegroundWindow())!=foreground)
        throw new ComputerFault("computer_focus_changed","Focus changed during Unicode text input.");
      var inputs=new List<NativeInput>(); var releases=new List<NativeInput>();
      int end=Math.Min(start+128,text.Length);
      for(int i=start;i<end;i++) {
        inputs.Add(Key(0,text[i],4)); inputs.Add(Key(0,text[i],6)); releases.Add(Key(0,text[i],6));
      }
      try { dispatch.Send(inputs.ToArray()); }
      catch { dispatch.Cleanup(releases.ToArray()); throw; }
    }
  }
}
`;

// src/computer-access/computer/windows-native-script.ts
var WINDOWS_NATIVE_SCRIPT = String.raw`
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

public static partial class AbotComputer {
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength=15000000, RecursionLimit=64 };
  const int ImageMaxBytes=10485760;
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left,Top,Right,Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct Point { public int X,Y; }
  [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)] struct TokenStatistics {
    public Luid TokenId,AuthenticationId; public long ExpirationTime;
    public int TokenType,ImpersonationLevel; public uint DynamicCharged,DynamicAvailable,GroupCount,PrivilegeCount;
    public Luid ModifiedId;
  }
  delegate bool EnumWindowCallback(IntPtr window,IntPtr parameter);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window,out Rect rectangle);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowCallback callback,IntPtr parameter);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window,StringBuilder text,int count);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint processId);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr obj,int index,StringBuilder text,int size,out int required);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window,int command);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int type,out TokenStatistics information,int length,out int needed);
  [DllImport("dwmapi.dll")] static extern int DwmFlush();

  sealed class ComputerFault : Exception {
    public readonly string Code;
    public ComputerFault(string code,string message):base(message) { Code=code; }
  }
  static Dictionary<string,object> Obj(params object[] pairs) {
    var result=new Dictionary<string,object>();
    for(int i=0;i<pairs.Length;i+=2) result.Add((string)pairs[i],pairs[i+1]);
    return result;
  }
  static Dictionary<string,object> Record(object value) {
    var result=value as Dictionary<string,object>;
    if(result==null) throw new ComputerFault("computer_request_invalid","Expected a structured object.");
    return result;
  }
  static object Field(Dictionary<string,object> value,string key) {
    object result; return value.TryGetValue(key,out result)?result:null;
  }
  static string Text(Dictionary<string,object> value,string key,int limit) {
    var result=Field(value,key) as string;
    if(result==null || result.Length>limit) throw new ComputerFault("computer_request_invalid","Invalid text field: "+key);
    return result;
  }
  static double Number(Dictionary<string,object> value,string key) {
    object raw=Field(value,key);
    if(!(raw is int) && !(raw is long) && !(raw is decimal) && !(raw is double))
      throw new ComputerFault("computer_request_invalid","Invalid numeric field: "+key);
    double result=Convert.ToDouble(raw);
    if(Double.IsInfinity(result) || Double.IsNaN(result)) throw new ComputerFault("computer_request_invalid","Non-finite number.");
    return result;
  }
  static int Integer(Dictionary<string,object> value,string key,int min,int max) {
    double number=Number(value,key);
    if(number!=Math.Truncate(number) || number<min || number>max)
      throw new ComputerFault("computer_request_invalid","Out-of-range integer: "+key);
    return (int)number;
  }
  static Dictionary<string,object> Rectangle(int x,int y,int width,int height) {
    return Obj("x",x,"y",y,"width",width,"height",height);
  }
  static Rect ParseRectangle(object value) {
    var data=Record(value);
    int x=PhysicalPixel(data,"x",-131072,131072),y=PhysicalPixel(data,"y",-131072,131072);
    int width=PhysicalPixel(data,"width",1,65536),height=PhysicalPixel(data,"height",1,65536);
    return new Rect { Left=x,Top=y,Right=x+width,Bottom=y+height };
  }
  static int PhysicalPixel(Dictionary<string,object> data,string key,int min,int max) {
    double number=Number(data,key);
    if(number<min || number>max) throw new ComputerFault("computer_request_invalid","Invalid physical pixel field: "+key);
    return (int)Math.Round(number);
  }
  static bool SameRectangle(Rect left,Rect right) {
    if(left.Left!=right.Left) return false;
    if(left.Top!=right.Top) return false;
    if(left.Right!=right.Right) return false;
    return left.Bottom==right.Bottom;
  }
  static bool ContainsRectangle(Rect outer,Rect inner) {
    if(inner.Left<outer.Left || inner.Top<outer.Top) return false;
    if(inner.Right>outer.Right || inner.Bottom>outer.Bottom) return false;
    return inner.Right>inner.Left && inner.Bottom>inner.Top;
  }
  static bool HasExpiredAction(Dictionary<string,object> request) {
    return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()>Number(request,"deadlineEpochMs");
  }
  static void PreparePhysicalCoordinates() {
    try { if(SetThreadDpiAwarenessContext(new IntPtr(-4))!=IntPtr.Zero) return; }
    catch(EntryPointNotFoundException) {}
    SetProcessDPIAware();
  }
  static void SetError(Dictionary<string,object> result,Exception error) {
    if(result.ContainsKey("error")) return;
    var fault=error as ComputerFault;
    result["error"]=Obj("code",fault==null?"computer_native_failed":fault.Code,
      "message",fault==null?"The native observation or input operation failed.":fault.Message);
  }
  public static string Run(string requestJson) {
    Dictionary<string,object> result=UnavailableResult("computer_native_failed");
    Dictionary<string,object> request=null;
    DispatchState dispatch=null;
    try {
      request=Record(Json.DeserializeObject(requestJson));
      string operation=Text(request,"operation",32);
      if(operation!="inspect" && operation!="observe" && operation!="act")
        throw new ComputerFault("computer_request_invalid","Unknown native operation.");
      if(operation=="act") dispatch=new DispatchState();
      PreparePhysicalCoordinates();
      result=DesktopSnapshot();
      if(operation=="inspect") return Json.Serialize(result);
      if(operation=="observe") RequireObservationSource(request,result);
      if(operation=="act") {
        try {
          Act(request,result,dispatch);
          if(dispatch.Failure!=null) throw new ComputerFault(dispatch.Failure,"Input cleanup was not fully accepted by Windows.");
        } catch(Exception error) { dispatch.Fail(error); SetError(result,error); }
        object actionError=Field(result,"error");
        result=DesktopSnapshot();
        RequireObservationSource(request,result);
        if(actionError!=null) result["error"]=actionError;
        if(dispatch.Started) { try { DwmFlush(); } catch(DllNotFoundException) {} }
      }
      try { CaptureObservation(result,operation=="observe"?Field(request,"region"):null); }
      catch(Exception error) { SetError(result,error); }
    } catch(Exception error) { SetError(result,error); }
    if(dispatch!=null) result["dispatch"]=dispatch.Result();
    return Json.Serialize(result);
  }
}
`;

// src/computer-access/computer/windows-topology-script.ts
var WINDOWS_TOPOLOGY_SCRIPT = String.raw`
public static partial class AbotComputer {
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct CaptureMonitorInfo {
    public int Size; public Rect Monitor,Work; public uint Flags;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string Device;
  }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct CaptureDisplayMode {
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string DeviceName;
    public ushort SpecVersion,DriverVersion,Size,DriverExtra; public uint Fields;
    public int PositionX,PositionY; public uint Orientation,FixedOutput;
    public short Color,Duplex,YResolution,TTOption,Collate;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string FormName;
    public ushort LogPixels; public uint BitsPerPixel,PixelWidth,PixelHeight,DisplayFlags,Frequency;
    public uint IcmMethod,IcmIntent,MediaType,DitherType,Reserved1,Reserved2,PanningWidth,PanningHeight;
  }
  delegate bool CaptureMonitorCallback(IntPtr monitor,IntPtr dc,ref Rect bounds,IntPtr data);
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct CaptureDisplayDevice {
    public int Size;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string Name;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)] public string Description;
    public uint Flags;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)] public string InterfaceId;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)] public string RegistryKey;
  }
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc,IntPtr clip,CaptureMonitorCallback callback,IntPtr data);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor,ref CaptureMonitorInfo info);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool EnumDisplaySettingsEx(string device,int mode,ref CaptureDisplayMode settings,uint flags);
  [DllImport("shcore.dll")] static extern int GetScaleFactorForMonitor(IntPtr monitor,out int scale);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool EnumDisplayDevices(string device,uint index,ref CaptureDisplayDevice info,uint flags);

  static bool TryMonitorScale(IntPtr monitor,out int scale) {
    scale=0;
    try { return GetScaleFactorForMonitor(monitor,out scale)==0; }
    catch(DllNotFoundException) { return false; }
    catch(EntryPointNotFoundException) { return false; }
  }

  static string SourceFingerprint(List<string> records) {
    records.Sort(StringComparer.Ordinal);
    using(var hash=System.Security.Cryptography.SHA256.Create()) {
      return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(Json.Serialize(records)))).Replace("-","").ToLowerInvariant();
    }
  }
  static string MonitorSourceIds(string device) {
    var sources=new List<string>();
    for(uint index=0;index<128;index++) {
      var info=new CaptureDisplayDevice { Size=Marshal.SizeOf(typeof(CaptureDisplayDevice)) };
      if(!EnumDisplayDevices(device,index,ref info,1)) break;
      if((info.Flags&1)==0) continue;
      if(String.IsNullOrEmpty(info.InterfaceId)) return null;
      sources.Add(info.InterfaceId);
    }
    if(sources.Count==0) return null;
    return SourceFingerprint(sources);
  }
  static string ReadCaptureTopology() {
    var records=new List<string>(); bool queryFailed=false;
    CaptureMonitorCallback callback=delegate(IntPtr monitor,IntPtr dc,ref Rect bounds,IntPtr data) {
      if(records.Count>=128) { queryFailed=true; return false; }
      var info=new CaptureMonitorInfo { Size=Marshal.SizeOf(typeof(CaptureMonitorInfo)) };
      if(!GetMonitorInfo(monitor,ref info)) { queryFailed=true; return false; }
      var mode=new CaptureDisplayMode { Size=(ushort)Marshal.SizeOf(typeof(CaptureDisplayMode)) };
      if(!EnumDisplaySettingsEx(info.Device,-1,ref mode,0)) { queryFailed=true; return false; }
      int scale;
      if(!TryMonitorScale(monitor,out scale)) { queryFailed=true; return false; }
      string sources=MonitorSourceIds(info.Device);
      if(sources==null) { queryFailed=true; return false; }
      records.Add(Json.Serialize(new object[] {info.Device,monitor.ToInt64(),info.Monitor.Left,info.Monitor.Top,
        info.Monitor.Right,info.Monitor.Bottom,info.Flags,mode.Orientation,mode.FixedOutput,
        mode.PixelWidth,mode.PixelHeight,mode.PositionX,mode.PositionY,scale,sources}));
      return true;
    };
    bool complete=EnumDisplayMonitors(IntPtr.Zero,IntPtr.Zero,callback,IntPtr.Zero);
    if(!complete || queryFailed || records.Count==0)
      throw new ComputerFault("computer_topology_unavailable","The monitor source arrangement could not be verified.");
    return SourceFingerprint(records);
  }
}
`;

// src/computer-access/computer/windows-helper-script.ts
var WINDOWS_COMPUTER_SOURCE = [
  WINDOWS_NATIVE_SCRIPT,
  WINDOWS_TOPOLOGY_SCRIPT,
  WINDOWS_DESKTOP_SCRIPT,
  WINDOWS_CAPTURE_SCRIPT,
  WINDOWS_ACCESSIBILITY_SCRIPT,
  WINDOWS_INPUT_SCRIPT,
  WINDOWS_KEYBOARD_SCRIPT
].join("\n");

// src/computer-access/computer/windows-result.ts
var PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function windowsHelperUnavailable(request, reason, spawned) {
  const capability = { supported: true, available: false, reason };
  return {
    desktop: {
      platform: "windows",
      binding: "windows:unavailable",
      name: "Windows desktop",
      available: false,
      reason,
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      capabilities: { capture: capability, accessibility: capability, input: capability, windows: capability },
      targetingGuarantee: "observed_surface"
    },
    windows: [],
    ...request.operation === "act" ? {
      dispatch: {
        status: spawned ? "unknown" : "not_dispatched",
        requestedInputCount: 0,
        ...spawned ? {} : { acceptedInputCount: 0 },
        reason: spawned ? "native_receipt_unavailable" : reason
      }
    } : {},
    error: {
      code: reason,
      message: spawned && request.operation === "act" ? "The Windows action receipt is unavailable. Input may have occurred; observe the desktop before another action. No action was replayed." : "The Windows desktop helper is unavailable for this operation."
    }
  };
}
function decodeWindowsComputerResult(process2, request) {
  if (process2.status !== "completed")
    return windowsHelperUnavailable(request, `computer_helper_${process2.status}`, process2.spawned);
  let result;
  let image;
  try {
    const wire = JSON.parse(process2.stdout.trim());
    if (wire === null || typeof wire !== "object" || Array.isArray(wire)) throw new Error("invalid result");
    const { image: nativeImage, ...metadata } = wire;
    result = readNativeComputerResult(metadata);
    image = nativeImage;
    if (result.desktop.platform !== "windows") throw new Error("wrong platform");
    if (request.operation === "act" && !result.dispatch) throw new Error("missing dispatch");
  } catch {
    return windowsHelperUnavailable(request, "computer_helper_protocol_invalid", process2.spawned);
  }
  try {
    if (image === void 0) {
      if (request.operation !== "inspect" && !result.error) throw new Error("missing observation");
      return result;
    }
    const bytes = decodeWindowsImage(image, result);
    return { ...result, image: { mimeType: "image/png", bytes } };
  } catch {
    if (result.dispatch) return {
      ...result,
      error: {
        code: "computer_image_decode_failed",
        message: "The native input receipt is preserved, but the captured image is invalid or unavailable. Observe again before another action."
      }
    };
    return windowsHelperUnavailable(request, "computer_helper_protocol_invalid", process2.spawned);
  }
}
function decodeWindowsImage(value, result) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid image");
  const image = value;
  if (Object.keys(image).some((key) => key !== "mimeType" && key !== "base64")) throw new Error("invalid image fields");
  if (image.mimeType !== "image/png" || typeof image.base64 !== "string") throw new Error("invalid image encoding");
  if (image.base64.length > Math.ceil(WINDOWS_IMAGE_MAX_BYTES / 3) * 4) throw new Error("image too large");
  const bytes = Buffer.from(image.base64, "base64");
  try {
    validateWindowsImageBytes(bytes, image.base64, result);
    return bytes;
  } catch (error) {
    bytes.fill(0);
    throw error;
  }
}
function validateWindowsImageBytes(bytes, encoded, result) {
  if (bytes.length > WINDOWS_IMAGE_MAX_BYTES || bytes.length < 33) throw new Error("image size");
  if (bytes.toString("base64") !== encoded) throw new Error("noncanonical image encoding");
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("image signature");
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") throw new Error("image header");
  const observation = result.observation;
  if (!observation) throw new Error("missing observation metadata");
  if (bytes.readUInt32BE(16) !== observation.imageWidth || bytes.readUInt32BE(20) !== observation.imageHeight)
    throw new Error("image dimensions disagree");
}

// src/computer-access/computer/windows-backend.ts
function createWindowsComputerBackend(target, dependencies = {}) {
  if (target.id !== "windows") throw new Error("Windows backend requires a Windows target.");
  const runHelper = dependencies.runHelper ?? runWindowsComputerHelper;
  const active = /* @__PURE__ */ new Map();
  let closed = false;
  return {
    async execute(request, signal) {
      if (closed) return windowsHelperUnavailable(request, "computer_backend_closed", false);
      if (signal?.aborted) return windowsHelperUnavailable(request, "computer_helper_aborted", false);
      let validated;
      try {
        validated = readNativeComputerRequest(request);
      } catch {
        return windowsHelperUnavailable(request, "computer_input_invalid", false);
      }
      if (validated.operation === "act" && validated.deadlineEpochMs <= Date.now())
        return windowsHelperUnavailable(validated, "computer_action_expired", false);
      const controller = new AbortController();
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const pending = runHelper({
        executable: target.shell,
        source: WINDOWS_COMPUTER_SOURCE,
        request: validated,
        signal: combined
      }).then((result) => decodeWindowsComputerResult(result, validated));
      active.set(controller, pending);
      try {
        return await pending;
      } finally {
        active.delete(controller);
      }
    },
    async close() {
      closed = true;
      for (const controller of active.keys()) controller.abort();
      await Promise.allSettled(active.values());
    }
  };
}

// src/computer-access/computer/unix-native-process.ts
var import_node_child_process2 = require("node:child_process");
var import_node_crypto5 = require("node:crypto");

// src/computer-access/computer/unix-native-results.ts
var NATIVE_PNG_LIMIT = 10 * 1024 * 1024;
var NATIVE_JSON_LIMIT = Math.ceil(NATIVE_PNG_LIMIT / 3) * 4 + 512 * 1024;
function unavailableUnixDesktop(platform, reason, dispatch) {
  const unavailable = { supported: true, available: false, reason };
  return {
    desktop: {
      platform,
      binding: `unavailable:${platform}`,
      name: "User desktop",
      available: false,
      reason,
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      capabilities: {
        capture: unavailable,
        input: unavailable,
        accessibility: unavailable,
        windows: unavailable
      },
      targetingGuarantee: "observed_surface"
    },
    windows: [],
    ...dispatch ? { dispatch } : {},
    error: {
      code: reason,
      message: "The native desktop operation is unavailable. Inspect the reported prerequisite before trying again."
    }
  };
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function readUnixDispatch(value) {
  if (!isRecord(value)) throw new Error("native_dispatch_invalid");
  if (!["not_dispatched", "accepted", "partial", "unknown"].includes(
    String(value.status)
  ))
    throw new Error("native_dispatch_invalid");
  if (!Number.isSafeInteger(value.requestedInputCount) || Number(value.requestedInputCount) < 0)
    throw new Error("native_dispatch_invalid");
  if (value.acceptedInputCount !== void 0 && (!Number.isSafeInteger(value.acceptedInputCount) || Number(value.acceptedInputCount) < 0))
    throw new Error("native_dispatch_invalid");
  return value;
}
function readUnixNativeResult(value, platform) {
  if (!isRecord(value)) throw new Error("native_result_invalid");
  const { imageBase64, ...metadata } = value;
  const result = readNativeComputerResult(metadata);
  if (result.desktop.platform !== platform)
    throw new Error("native_desktop_invalid");
  let image;
  if (imageBase64 !== void 0) {
    if (typeof imageBase64 !== "string" || imageBase64.length > Math.ceil(NATIVE_PNG_LIMIT / 3) * 4)
      throw new Error("native_image_limit");
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(imageBase64))
      throw new Error("native_image_invalid");
    const bytes = Buffer.from(imageBase64, "base64");
    if (bytes.length > NATIVE_PNG_LIMIT || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      throw new Error("native_image_invalid");
    if (!result.observation)
      throw new Error("native_image_without_observation");
    image = { mimeType: "image/png", bytes };
  }
  return { ...result, ...image ? { image } : {} };
}

// src/computer-access/computer/unix-native-process.ts
function createUnixNativeProcess(options) {
  let child;
  let pending;
  let closed = false;
  let failedReason;
  let buffer = Buffer.alloc(0);
  let queue = Promise.resolve();
  let lastResult;
  function interruptedResult(reason) {
    const dispatch = pending?.request.operation === "act" ? pending.dispatch ?? {
      status: "unknown",
      requestedInputCount: 1,
      reason
    } : void 0;
    const result = unavailableUnixDesktop(options.platform, reason, dispatch);
    if (!lastResult) return result;
    return {
      ...result,
      desktop: { ...lastResult.desktop, available: false, reason },
      windows: lastResult.windows
    };
  }
  function terminate(reason) {
    failedReason = reason;
    pending?.finish(interruptedResult(reason));
    const retiring = child;
    retiring?.kill("SIGTERM");
    if (retiring) {
      const hardStop = setTimeout(() => retiring.kill("SIGKILL"), 3e3);
      hardStop.unref();
      retiring.once("exit", () => clearTimeout(hardStop));
    }
    child = void 0;
    buffer = Buffer.alloc(0);
  }
  function receiveLine(line) {
    const value = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("native_protocol_invalid");
    const message = value;
    if (!pending || message.id !== pending.id)
      throw new Error("native_response_identity_invalid");
    if (message.type === "dispatch") {
      pending.dispatch = readUnixDispatch(message.dispatch);
      return;
    }
    if (message.type !== "result") throw new Error("native_protocol_invalid");
    const result = readUnixNativeResult(message.result, options.platform);
    lastResult = result;
    pending.finish(result);
  }
  function ensureHelper() {
    if (child) return;
    child = (options.spawnProcess ?? import_node_child_process2.spawn)(options.file, [...options.args], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    child.stdin.on("error", () => terminate("computer_native_pipe_failed"));
    child.stderr.resume();
    child.stdout.on("data", (chunk) => {
      if (closed || failedReason) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > NATIVE_JSON_LIMIT) {
        terminate("computer_native_result_limit");
        return;
      }
      let boundary = buffer.indexOf(10);
      while (boundary >= 0) {
        const line = buffer.subarray(0, boundary).toString("utf8");
        buffer = buffer.subarray(boundary + 1);
        try {
          receiveLine(line);
        } catch {
          terminate("computer_native_protocol_invalid");
          return;
        }
        boundary = buffer.indexOf(10);
      }
    });
    child.once(
      "error",
      () => terminate("computer_native_dependency_unavailable")
    );
    child.once("exit", () => {
      if (!closed) terminate("computer_native_helper_stopped");
    });
  }
  function executeOne(request, signal) {
    if (closed || failedReason)
      return Promise.resolve(
        unavailableUnixDesktop(
          options.platform,
          failedReason ?? "computer_native_closed"
        )
      );
    if (signal?.aborted)
      return Promise.resolve(
        unavailableUnixDesktop(
          options.platform,
          "computer_native_aborted",
          request.operation === "act" ? {
            status: "not_dispatched",
            requestedInputCount: 1,
            acceptedInputCount: 0
          } : void 0
        )
      );
    return new Promise((resolve) => {
      const id = (0, import_node_crypto5.randomUUID)();
      let settled = false;
      let cancelTimer;
      const timeout = setTimeout(
        () => terminate("computer_native_timeout"),
        options.timeoutMs ?? 45e3
      );
      function finish(result) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (cancelTimer) clearTimeout(cancelTimer);
        signal?.removeEventListener("abort", abort);
        pending = void 0;
        resolve(result);
      }
      function abort() {
        child?.stdin.write(JSON.stringify({ type: "cancel", id }) + "\n");
        cancelTimer = setTimeout(
          () => terminate("computer_native_cancelled_unknown"),
          options.cancellationGraceMs ?? 1e3
        );
      }
      pending = { id, request, finish };
      try {
        ensureHelper();
        child.stdin.write(
          JSON.stringify({ type: "request", id, request }) + "\n"
        );
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      } catch {
        terminate("computer_native_dependency_unavailable");
      }
    });
  }
  return {
    execute(request, signal) {
      const result = queue.then(() => executeOne(request, signal));
      queue = result.then(
        () => void 0,
        () => void 0
      );
      return result;
    },
    async close() {
      if (closed) return;
      closed = true;
      child?.stdin.write(JSON.stringify({ type: "close" }) + "\n");
      terminate("computer_native_closed");
    }
  };
}

// src/computer-access/computer/macos-desktop.ts
var MACOS_DESKTOP_SOURCE = String.raw`
import Foundation
import AppKit
import ApplicationServices
import ScreenCaptureKit
import ImageIO
import Darwin
struct NativeFailure: Error {
  let code: String
  init(_ code: String) {
    self.code=code
  }
}
let outputLock=NSLock()
func emit(_ value: [String:Any]) {
  guard let data=try? JSONSerialization.data(withJSONObject:value), let text=String(data:data,encoding:.utf8) else {
    return
  }
  outputLock.lock()
  print(text)
  fflush(stdout)
  outputLock.unlock()
}
func capability(_ available: Bool,_ reason: String = "",supported: Bool = true) -> [String:Any] {
  var result:[String:Any] = ["supported":supported,"available":available]
  if !available && !reason.isEmpty {
    result["reason"]=reason
  }
  return result
}
func rectJSON(_ rect: CGRect) -> [String:Any] {
  return ["x":rect.minX,"y":rect.minY,"width":rect.width,"height":rect.height]
}
func boundedText(_ value:String,_ limit:Int=256) -> String {
  var result="",length=0
  for scalar in value.unicodeScalars {
    let text=String(scalar)
    if length+text.utf8.count>limit { break }
    result+=text
    length+=text.utf8.count
  }
  return result
}
func readRect(_ value: Any?) -> CGRect? {
  guard let value=value as? [String:Double], let x=value["x"],let y=value["y"],let w=value["width"],let h=value["height"], [x,y,w,h].allSatisfy({
    $0.isFinite
  }
  ), w>0,h>0 else {
    return nil
  }
  return CGRect(x:x,y:y,width:w,height:h)
}
func axAttribute(_ element: AXUIElement,_ name: String) -> CFTypeRef? {
  var value:CFTypeRef?
  return AXUIElementCopyAttributeValue(element,name as CFString,&value) == .success ? value : nil
}
func axElement(_ value: CFTypeRef?) -> AXUIElement? {
  guard let value=value,CFGetTypeID(value)==AXUIElementGetTypeID() else {
    return nil
  }
  return unsafeBitCast(value,to:AXUIElement.self)
}
func axBounds(_ element: AXUIElement) -> CGRect? {
  guard let position=axAttribute(element,kAXPositionAttribute),CFGetTypeID(position)==AXValueGetTypeID(),let size=axAttribute(element,kAXSizeAttribute),CFGetTypeID(size)==AXValueGetTypeID() else {
    return nil
  }
  var point=CGPoint.zero,dimensions=CGSize.zero
  guard AXValueGetValue(unsafeBitCast(position,to:AXValue.self),.cgPoint,&point),AXValueGetValue(unsafeBitCast(size,to:AXValue.self),.cgSize,&dimensions),dimensions.width>0,dimensions.height>0 else {
    return nil
  }
  return CGRect(origin:point,size:dimensions)
}
struct WindowReference {
  let element:AXUIElement
  let pid:pid_t
  let binding:String
}
var windowReferences=[WindowReference]()
let desktopSessionBinding="macos:"+String(getuid())+":"+UUID().uuidString
func displayBounds() -> CGRect {
  return readDisplaySource()?.bounds ?? CGRect(x:0,y:0,width:1,height:1)
}
func sessionAvailable() -> Bool {
  guard let session=CGSessionCopyCurrentDictionary() as? [String:Any] else {
    return false
  }
  if session["CGSSessionScreenIsLocked"] as? Bool == true {
    return false
  }
  return session[kCGSessionOnConsoleKey as String] as? Bool == true
}
func hasScreenCapture() -> Bool {
  guard #available(macOS 14.0,*) else {
    return false
  }
  return CGPreflightScreenCaptureAccess()
}
func targetingGuaranteeForFocus(_ focused:String?) -> String {
  guard let focused=focused,!focused.isEmpty else { return "observed_surface" }
  return "verified_window"
}
func desktopState() -> [String:Any] {
  let source=readDisplaySource()
  let available=sessionAvailable() && source != nil,accessible=AXIsProcessTrusted()
  let bounds=source?.bounds ?? CGRect(x:0,y:0,width:1,height:1)
  var current=[WindowReference](),windows=[[String:Any]](),focused:String?
  if available && accessible {
    let foreground=NSWorkspace.shared.frontmostApplication?.processIdentifier
    for app in NSWorkspace.shared.runningApplications where !app.isTerminated {
      if windows.count>=64 {
        break
      }
      let root=AXUIElementCreateApplication(app.processIdentifier)
      let active=axElement(axAttribute(root,kAXFocusedWindowAttribute))
      for item in (axAttribute(root,kAXWindowsAttribute) as? [AXUIElement] ?? []).prefix(64-windows.count) {
        guard let frame=axBounds(item) else {
          continue
        }
        let old=windowReferences.first {
          $0.pid==app.processIdentifier && CFEqual($0.element,item)
        }
        let reference=WindowReference(element:item,pid:app.processIdentifier,binding:old?.binding ?? UUID().uuidString)
        current.append(reference)
        let isFocused=foreground==app.processIdentifier && active.map {
          CFEqual($0,item)
        }
        == true
        let title=boundedText(axAttribute(item,kAXTitleAttribute) as? String ?? "",128)
        windows.append(["binding":reference.binding,"title":title,"application":boundedText(app.bundleIdentifier ?? app.localizedName ?? "",128),"bounds":rectJSON(frame),"focused":isFocused])
        if isFocused {
          focused=reference.binding
        }
      }
    }
  }
  windowReferences=current
  let permissions:[String:Any] = ["capture":capability(available && hasScreenCapture(),"macos_screen_recording_permission_or_macos14_required"),"input":capability(available && accessible,"macos_accessibility_permission_required"),"accessibility":capability(available && accessible,"macos_accessibility_permission_required"),"windows":capability(available && accessible,"macos_accessibility_permission_required")]
  var desktop:[String:Any] = ["platform":"macos","binding":source?.binding ?? desktopSessionBinding+":unavailable","name":"Mac user desktop","available":available,"bounds":rectJSON(bounds),"capabilities":permissions,"targetingGuarantee":targetingGuaranteeForFocus(focused),"coordinateSpace":"logical_points"]
  if !available {
    desktop["reason"]="macos_session_locked_or_unavailable"
  }
  if source == nil { desktop["reason"]="macos_topology_unavailable" }
  var state:[String:Any] = ["desktop":desktop,"windows":windows]
  if let focused=focused {
    state["focusedWindow"]=focused
  }
  return state
}
func accessibilitySnapshot(_ binding:String?) -> ([[String:Any]],Bool) {
  guard let binding=binding,let root=windowReferences.first(where:{
    $0.binding==binding
  }
  )?.element else {
    return ([],false)
  }
  var pending=[root],nodes=[[String:Any]](),visited=0,length=0
  let deadline=Date().addingTimeInterval(0.4)
  while !pending.isEmpty && nodes.count<64 && visited<400 && length<24000 && Date()<deadline {
    let item=pending.removeFirst()
    visited+=1
    if axAttribute(item,kAXSubroleAttribute) as? String == "AXSecureTextField" {
      continue
    }
    if axAttribute(item,"AXHidden") as? Bool == true {
      continue
    }
    let role=axAttribute(item,kAXRoleAttribute) as? String ?? "unknown"
    let children=axAttribute(item,kAXChildrenAttribute) as? [AXUIElement] ?? []
    var node:[String:Any] = ["role":boundedText(role,64),"name":boundedText(axAttribute(item,kAXTitleAttribute) as? String ?? axAttribute(item,kAXDescriptionAttribute) as? String ?? "",128)]
    if children.isEmpty,let value=axAttribute(item,kAXValueAttribute) as? String {
      node["value"]=boundedText(value)
    }
    if let frame=axBounds(item) {
      node["bounds"]=rectJSON(frame)
    }
    if let isFocused=axAttribute(item,kAXFocusedAttribute) as? Bool {
      node["focused"]=isFocused
    }
    length+=(node["name"] as? String ?? "").count+(node["value"] as? String ?? "").count
    nodes.append(node)
    pending.append(contentsOf:children.prefix(max(0,400-pending.count)))
  }
  return (nodes,!pending.isEmpty)
}
`;

// src/computer-access/computer/macos-capture.ts
var MACOS_CAPTURE_SOURCE = String.raw`
func requireObservationSource(_ request:[String:Any],_ state:[String:Any]) throws {
  guard request["region"] != nil || request["operation"] as? String == "act" else { return }
  guard let desktop=state["desktop"] as? [String:Any] else { throw NativeFailure("computer_desktop_stale") }
  guard request["desktopBinding"] as? String == desktop["binding"] as? String else {
    throw NativeFailure("computer_desktop_stale")
  }
  guard let geometry=readRect(request["expectedGeometry"]),geometry==readRect(desktop["bounds"]) else {
    throw NativeFailure("computer_geometry_changed")
  }
}
func requireCaptureSourceGeometry(_ state:[String:Any],_ bounds:CGRect) throws {
  guard let desktop=state["desktop"] as? [String:Any],let source=readRect(desktop["bounds"]) else {
    throw NativeFailure("computer_geometry_changed")
  }
  guard source==bounds else { throw NativeFailure("computer_geometry_changed") }
  _ = try requireDesktopSourceBinding(desktop["binding"] as? String)
}
final class CaptureValue<T> {
  let lock=NSLock()
  var value:T?
  var error:Error?
  func store(_ value:T?,_ error:Error?) {
    lock.lock()
    self.value=value
    self.error=error
    lock.unlock()
  }
}
@available(macOS 14.0,*)
func captureScreens(_ region:CGRect,_ binding:String?) throws -> (Data,Int,Int) {
  let contentValue=CaptureValue<SCShareableContent>(),ready=DispatchSemaphore(value:0)
  SCShareableContent.getExcludingDesktopWindows(false,onScreenWindowsOnly:true) {
    content,error in contentValue.store(content,error)
    ready.signal()
  }
  guard ready.wait(timeout:.now()+10) == .success,let content=contentValue.value else {
    throw NativeFailure("macos_shareable_content_unavailable")
  }
  let source=try requireDesktopSourceBinding(binding)
  let scale=min(1.0,2048.0/max(region.width,region.height))
  let width=max(1,Int(ceil(region.width*scale))),height=max(1,Int(ceil(region.height*scale)))
  guard let space=CGColorSpace(name:CGColorSpace.sRGB),let canvas=CGContext(data:nil,width:width,height:height,bitsPerComponent:8,bytesPerRow:width*4,space:space,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else {
    throw NativeFailure("macos_capture_buffer_unavailable")
  }
  canvas.setFillColor(CGColor(gray:0,alpha:1))
  canvas.fill(CGRect(x:0,y:0,width:CGFloat(width),height:CGFloat(height)))
  var captured=0
  for identifier in source.displays {
    guard let display=content.displays.first(where: { $0.displayID==identifier }) else {
      throw NativeFailure("macos_capture_source_unavailable")
    }
    let displayFrame=CGDisplayBounds(display.displayID),part=region.intersection(displayFrame)
    if part.isNull || part.isEmpty {
      continue
    }
    let configuration=SCStreamConfiguration()
    configuration.width=max(1,Int(ceil(part.width*scale)))
    configuration.height=max(1,Int(ceil(part.height*scale)))
    configuration.sourceRect=CGRect(x:part.minX-displayFrame.minX,y:part.minY-displayFrame.minY,width:part.width,height:part.height)
    configuration.showsCursor=true
    let filter=SCContentFilter(display:display,excludingWindows:[])
    let imageValue=CaptureValue<CGImage>(),imageReady=DispatchSemaphore(value:0)
    SCScreenshotManager.captureImage(contentFilter:filter,configuration:configuration) {
      image,error in imageValue.store(image,error)
      imageReady.signal()
    }
    guard imageReady.wait(timeout:.now()+10) == .success,let image=imageValue.value else {
      throw NativeFailure("macos_capture_failed")
    }
    let destination=CGRect(x:(part.minX-region.minX)*scale,y:(region.maxY-part.maxY)*scale,width:part.width*scale,height:part.height*scale)
    canvas.draw(image,in:destination)
    captured+=1
  }
  guard captured>0,let image=canvas.makeImage() else {
    throw NativeFailure("macos_capture_empty")
  }
  let output=NSMutableData()
  guard let destination=CGImageDestinationCreateWithData(output as CFMutableData,"public.png" as CFString,1,nil) else {
    throw NativeFailure("macos_png_encoder_unavailable")
  }
  let properties:[CFString:Any] = [kCGImagePropertyPNGDictionary:[kCGImagePropertyPNGInterlaceType:0]]
  CGImageDestinationAddImage(destination,image,properties as CFDictionary)
  guard CGImageDestinationFinalize(destination),output.length<=10*1024*1024 else {
    throw NativeFailure("computer_capture_size_limit")
  }
  return (output as Data,width,height)
}
func addCapture(_ state:[String:Any],_ requested:Any?) throws -> [String:Any] {
  guard #available(macOS 14.0,*) else {
    throw NativeFailure("macos14_capture_required")
  }
  guard sessionAvailable() else {
    throw NativeFailure("macos_session_locked_or_unavailable")
  }
  if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
  guard CGPreflightScreenCaptureAccess() else { throw NativeFailure("macos_screen_recording_permission_required") }
  let bounds=displayBounds(),region=readRect(requested) ?? bounds
  try requireCaptureSourceGeometry(state,bounds)
  guard bounds.contains(region),region.width>0,region.height>0 else {
    throw NativeFailure("computer_region_outside_desktop")
  }
  let desktop=state["desktop"] as? [String:Any]
  let (image,width,height)=try captureScreens(region,desktop?["binding"] as? String)
  guard sessionAvailable(),displayBounds()==bounds else {
    throw NativeFailure("computer_geometry_changed_during_capture")
  }
  let (nodes,truncated)=accessibilitySnapshot(state["focusedWindow"] as? String)
  let current=desktopState()
  try requireCaptureSourceGeometry(state,bounds)
  guard state["focusedWindow"] as? String == current["focusedWindow"] as? String else { throw NativeFailure("computer_focus_changed_during_capture") }
  var result=state
  result["observation"]=["capturedAt":ISO8601DateFormatter().string(from:Date()),"region":rectJSON(region),"imageWidth":width,"imageHeight":height,"accessibility":nodes,"accessibilityTruncated":truncated]
  result["imageBase64"]=image.base64EncodedString()
  return result
}
`;

// src/computer-access/computer/macos-input.ts
var MACOS_INPUT_SOURCE = String.raw`
func incompleteDispatchError(_ dispatch:[String:Any]) -> [String:Any]? {
  if dispatch["status"] as? String == "partial" {
    return ["code":"computer_input_partial","message":"Native input was only partially dispatched. Inspect the receipt and fresh observation before another action."]
  }
  if dispatch["status"] as? String == "unknown" {
    return ["code":"computer_input_unknown","message":"Native input dispatch is uncertain. Inspect the receipt and fresh observation before another action."]
  }
  return nil
}
final class CancellationFlag {
  let lock=NSLock()
  var cancelled=false
  func cancel() {
    lock.lock()
    cancelled=true
    lock.unlock()
  }
  func check(_ deadline:Double) throws {
    lock.lock()
    let stopped=cancelled
    lock.unlock()
    if stopped {
      throw NativeFailure("computer_action_cancelled")
    }
    if Date().timeIntervalSince1970*1000>deadline {
      throw NativeFailure("computer_action_deadline")
    }
  }
}
let keyCodes:[String:CGKeyCode] = ["a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"=":24,"9":25,"7":26,"-":27,"8":28,"0":29,"]":30,"o":31,"u":32,"[":33,"i":34,"p":35,"l":37,"j":38,"'":39,"k":40,";":41,"\\":42,",":43,"/":44,"n":45,"m":46,".":47,"\u{60}":50,"Enter":36,"Return":36,"Tab":48,"Space":49,"Backspace":51,"Delete":117,"Esc":53,"Escape":53,"Meta":55,"Super":55,"Command":55,"Shift":56,"Alt":58,"Option":58,"Ctrl":59,"Control":59,"F1":122,"F2":120,"F3":99,"F4":118,"F5":96,"F6":97,"F7":98,"F8":100,"F9":101,"F10":109,"F11":103,"F12":111,"Home":115,"End":119,"PageUp":116,"PageDown":121,"ArrowLeft":123,"ArrowRight":124,"ArrowDown":125,"ArrowUp":126]
func nativeKey(_ value:String) throws -> CGKeyCode {
  if let key=keyCodes[value] {
    return key
  }
  if value.count==1,let key=keyCodes[value.lowercased()] {
    return key
  }
  throw NativeFailure("macos_key_unsupported")
}
func modifierFlag(_ key:CGKeyCode) -> CGEventFlags {
  switch key {
    case 55:return .maskCommand
    case 56:return .maskShift
    case 58:return .maskAlternate
    case 59:return .maskControl
    default:return []
  }
}
func actionCount(_ action:[String:Any]) -> Int {
  switch action["kind"] as? String {
    case "type_text":return ((action["text"] as? String)?.unicodeScalars.count ?? 0)*2
    case "press_keys":return ((action["keys"] as? [String])?.count ?? 0)*2
    case "click":return 1+(action["count"] as? Int ?? 1)*2
    case "drag":return 15
    default:return 1
  }
}
func readPoint(_ value:Any?) throws -> CGPoint {
  guard let value=value as? [String:Double],let x=value["x"],let y=value["y"],x.isFinite,y.isFinite else {
    throw NativeFailure("computer_point_invalid")
  }
  return CGPoint(x:x,y:y)
}
func validateAction(_ action:[String:Any],_ state:[String:Any]) throws {
  guard let kind=action["kind"] as? String,["click","move","drag","scroll","type_text","press_keys","focus_window"].contains(kind) else {
    throw NativeFailure("computer_action_unsupported")
  }
  let bounds=displayBounds()
  let names=kind=="drag" ? ["from","to"] : ["click","move"].contains(kind) ? ["point"] : []
  for name in names {
    if !bounds.contains(try readPoint(action[name])) {
      throw NativeFailure("computer_point_outside_desktop")
    }
  }
  if ["click","drag"].contains(kind),!["left","middle","right"].contains(action["button"] as? String ?? "") {
    throw NativeFailure("computer_button_invalid")
  }
  if kind=="click",![1,2].contains(action["count"] as? Int ?? 0) {
    throw NativeFailure("computer_click_count_invalid")
  }
  if kind=="drag",!(0...5000).contains(action["durationMs"] as? Int ?? -1) {
    throw NativeFailure("computer_drag_duration_invalid")
  }
  if kind=="scroll" {
    guard let x=action["deltaX"] as? Double,let y=action["deltaY"] as? Double,x.isFinite,y.isFinite,abs(x)<=12000,abs(y)<=12000 else {
      throw NativeFailure("computer_scroll_invalid")
    }
    guard x.truncatingRemainder(dividingBy:120)==0,y.truncatingRemainder(dividingBy:120)==0 else {
      throw NativeFailure("macos_scroll_fraction_unsupported")
    }
  }
  if kind=="type_text" {
    guard let text=action["text"] as? String,text.utf16.count<=10000 else {
      throw NativeFailure("computer_text_limit")
    }
  }
  if kind=="press_keys" {
    guard let keys=action["keys"] as? [String],!keys.isEmpty,keys.count<=8 else {
      throw NativeFailure("computer_keys_invalid")
    }
    for key in keys {
      _ = try nativeKey(key)
    }
  }
  if kind=="focus_window",!windowReferences.contains(where:{
    $0.binding==action["windowBinding"] as? String
  }
  ) {
    throw NativeFailure("computer_window_stale")
  }
}
func requireVerifiedTextFocus(_ action:[String:Any],_ expectedWindow:String?) throws {
  guard action["kind"] as? String == "type_text" else { return }
  guard let expectedWindow=expectedWindow else { return }
  guard let reference=windowReferences.first(where: { $0.binding==expectedWindow }) else {
    throw NativeFailure("computer_focus_changed")
  }
  guard NSWorkspace.shared.frontmostApplication?.processIdentifier==reference.pid else {
    throw NativeFailure("computer_focus_changed")
  }
  let root=AXUIElementCreateApplication(reference.pid)
  guard let focused=axElement(axAttribute(root,kAXFocusedWindowAttribute)),CFEqual(focused,reference.element) else {
    throw NativeFailure("computer_focus_changed")
  }
}
func executeInput(_ id:String,_ action:[String:Any],_ cancel:CancellationFlag,_ deadline:Double,_ expectedWindow:String? = nil) throws -> [String:Any] {
  try cancel.check(deadline)
  guard let source=CGEventSource(stateID:.privateState) else {
    throw NativeFailure("macos_input_source_unavailable")
  }
  let requested=actionCount(action)
  var accepted=0,heldKeys=[CGKeyCode](),heldButton:CGMouseButton?,flags=CGEventFlags()
  var lastPoint=CGEvent(source:nil)?.location ?? .zero
  func post(_ event:CGEvent?) throws {
    try cancel.check(deadline)
    try requireVerifiedTextFocus(action,expectedWindow)
    guard let event=event else {
      throw NativeFailure("macos_input_event_unavailable")
    }
    event.flags=flags
    event.post(tap:.cghidEventTap)
    accepted+=1
  }
  func keyboard(_ key:CGKeyCode,_ down:Bool) throws {
    let flag=modifierFlag(key)
    if down {
      flags.formUnion(flag)
    }
    else {
      flags.subtract(flag)
    }
    try post(CGEvent(keyboardEventSource:source,virtualKey:key,keyDown:down))
    if down {
      heldKeys.append(key)
    }
    else {
      heldKeys.removeAll {
        $0==key
      }
    }
  }
  func mouse(_ type:CGEventType,_ point:CGPoint,_ button:CGMouseButton,_ click:Int=1) throws {
    let event=CGEvent(mouseEventSource:source,mouseType:type,mouseCursorPosition:point,mouseButton:button)
    event?.setIntegerValueField(.mouseEventClickState,value:Int64(click))
    try post(event)
    lastPoint=point
  }
  emit(["type":"dispatch","id":id,"dispatch":["status":"unknown","requestedInputCount":requested,"reason":"native_dispatch_started"]])
  var failure:String?
  do {
    let kind=action["kind"] as! String
    if kind=="move" {
      try mouse(.mouseMoved,try readPoint(action["point"]),.left)
    }
    if kind=="click" || kind=="drag" {
      let button:CGMouseButton = action["button"] as? String == "right" ? .right : action["button"] as? String == "middle" ? .center : .left
      let down:CGEventType = button == .left ? .leftMouseDown : button == .right ? .rightMouseDown : .otherMouseDown
      let up:CGEventType = button == .left ? .leftMouseUp : button == .right ? .rightMouseUp : .otherMouseUp
      let start=try readPoint(action[kind=="click" ? "point":"from"])
      try mouse(.mouseMoved,start,button)
      if kind=="click" {
        for number in 1...(action["count"] as! Int) {
          try mouse(down,start,button,number)
          heldButton=button
          try mouse(up,start,button,number)
          heldButton=nil
          if number==1 && action["count"] as! Int==2 {
            Thread.sleep(forTimeInterval:0.05)
          }
        }
      }
      else {
        let end=try readPoint(action["to"])
        try mouse(down,start,button)
        heldButton=button
        let dragged:CGEventType = button == .left ? .leftMouseDragged : button == .right ? .rightMouseDragged : .otherMouseDragged
        for step in 1...12 {
          let ratio=Double(step)/12
          try mouse(dragged,CGPoint(x:start.x+(end.x-start.x)*ratio,y:start.y+(end.y-start.y)*ratio),button)
          Thread.sleep(forTimeInterval:Double(action["durationMs"] as! Int)/12000)
        }
        try mouse(up,end,button)
        heldButton=nil
      }
    }
    if kind=="scroll" {
      let x=Int32((action["deltaX"] as! Double)/120),y=Int32((action["deltaY"] as! Double)/120)
      try post(CGEvent(scrollWheelEvent2Source:source,units:.line,wheelCount:2,wheel1:-y,wheel2:-x,wheel3:0))
    }
    if kind=="press_keys" {
      let keys=try (action["keys"] as! [String]).map {
        try nativeKey($0)
      }
      for key in keys {
        try keyboard(key,true)
      }
      for key in keys.reversed() {
        try keyboard(key,false)
      }
    }
    if kind=="type_text" {
      for scalar in (action["text"] as! String).unicodeScalars {
        var units=Array(String(scalar).utf16)
        for down in [true,false] {
          let event=CGEvent(keyboardEventSource:source,virtualKey:0,keyDown:down)
          event?.keyboardSetUnicodeString(stringLength:units.count,unicodeString:&units)
          try post(event)
          if down { heldKeys.append(0) } else { heldKeys.removeAll { $0 == 0 } }
        }
      }
    }
    if kind=="focus_window" {
      try cancel.check(deadline)
      guard let reference=windowReferences.first(where:{
        $0.binding==action["windowBinding"] as? String
      }
      ),let app=NSRunningApplication(processIdentifier:reference.pid) else {
        throw NativeFailure("computer_window_stale")
      }
      guard app.activate(options:[.activateIgnoringOtherApps]),AXUIElementPerformAction(reference.element,kAXRaiseAction as CFString) == .success else {
        throw NativeFailure("macos_window_focus_failed")
      }
      accepted+=1
    }
  }
  catch {
    failure=(error as? NativeFailure)?.code ?? "macos_native_input_failed"
  }
  // Release only this operation's own held input, even after cooperative cancellation.
  for key in heldKeys.reversed() {
    flags.subtract(modifierFlag(key))
    let event=CGEvent(keyboardEventSource:source,virtualKey:key,keyDown:false)
    event?.flags=flags
    event?.post(tap:.cghidEventTap)
  }
  if let button=heldButton {
    let type:CGEventType = button == .left ? .leftMouseUp : button == .right ? .rightMouseUp : .otherMouseUp
    CGEvent(mouseEventSource:source,mouseType:type,mouseCursorPosition:lastPoint,mouseButton:button)?.post(tap:.cghidEventTap)
  }
  var dispatch:[String:Any] = ["status":failure==nil ? "accepted":accepted>0 ? "partial":"unknown","requestedInputCount":requested,"acceptedInputCount":accepted]
  if let failure=failure {
    dispatch["reason"]=failure
  }
  return dispatch
}
`;

// src/computer-access/computer/macos-topology.ts
var MACOS_TOPOLOGY_SOURCE = String.raw`
import CryptoKit
struct DisplaySourceSnapshot {
  let binding:String
  let bounds:CGRect
  let displays:[CGDirectDisplayID]
}
func readDisplaySource() -> DisplaySourceSnapshot? {
  var count:UInt32=0
  guard CGGetActiveDisplayList(0,nil,&count) == .success,count>0,count<=128 else { return nil }
  var displays=[CGDirectDisplayID](repeating:0,count:Int(count))
  guard CGGetActiveDisplayList(count,&displays,&count) == .success else { return nil }
  let identifiers=Array(displays.prefix(Int(count))).sorted()
  var records=[[String:Any]](),bounds=CGRect.null
  for identifier in identifiers {
    let frame=CGDisplayBounds(identifier)
    guard !frame.isEmpty,let mode=CGDisplayCopyDisplayMode(identifier) else { return nil }
    bounds=bounds.union(frame)
    records.append(["id":identifier,"rect":rectJSON(frame),"rotation":CGDisplayRotation(identifier),
      "mode":mode.ioDisplayModeID,"width":mode.width,"height":mode.height,
      "pixelWidth":mode.pixelWidth,"pixelHeight":mode.pixelHeight,
      "mirrors":CGDisplayMirrorsDisplay(identifier),"main":CGDisplayIsMain(identifier)])
  }
  guard let data=try? JSONSerialization.data(withJSONObject:records,options:[.sortedKeys]) else { return nil }
  let fingerprint=SHA256.hash(data:data).map { String(format:"%02x",$0) }.joined()
  return DisplaySourceSnapshot(binding:desktopSessionBinding+":"+fingerprint,bounds:bounds,displays:identifiers)
}
func requireDesktopSourceBinding(_ expected:String?) throws -> DisplaySourceSnapshot {
  guard let source=readDisplaySource() else { throw NativeFailure("macos_topology_unavailable") }
  guard expected==source.binding else { throw NativeFailure("computer_desktop_stale") }
  return source
}
`;

// src/computer-access/computer/macos-helper.ts
var MACOS_COMMAND_LOOP = String.raw`
func perform(_ id:String,_ request:[String:Any],_ cancel:CancellationFlag) -> [String:Any] {
  var state=desktopState(),dispatch:[String:Any]?
  do {
    let operation=request["operation"] as? String
    if operation=="inspect" {
      return state
    }
    if operation=="observe" {
      try requireObservationSource(request,state)
      return try addCapture(state,request["region"])
    }
    guard operation=="act",let action=request["action"] as? [String:Any],let deadline=request["deadlineEpochMs"] as? Double else {
      throw NativeFailure("computer_request_invalid")
    }
    try cancel.check(deadline)
    guard sessionAvailable() else {
      throw NativeFailure("macos_session_locked_or_unavailable")
    }
    guard AXIsProcessTrusted() else {
      throw NativeFailure("macos_accessibility_permission_required")
    }
    _ = try requireDesktopSourceBinding(request["desktopBinding"] as? String)
    guard let geometry=readRect(request["expectedGeometry"]),geometry==displayBounds() else {
      throw NativeFailure("computer_geometry_changed")
    }
    if let expected=request["expectedWindow"] as? String,expected != state["focusedWindow"] as? String {
      throw NativeFailure("computer_focus_changed")
    }
    try validateAction(action,state)
    _ = try requireDesktopSourceBinding(request["desktopBinding"] as? String)
    dispatch=try executeInput(id,action,cancel,deadline,request["expectedWindow"] as? String)
    emit(["type":"dispatch","id":id,"dispatch":dispatch!])
    state=desktopState()
    state["dispatch"]=dispatch
    try requireObservationSource(request,state)
    if let dispatchError=incompleteDispatchError(dispatch!) {
      state["error"]=dispatchError
    }
    if action["kind"] as? String=="focus_window",state["focusedWindow"] as? String != action["windowBinding"] as? String {
      state["error"]=["code":"computer_focus_not_confirmed","message":"The activation request was dispatched but target focus is not confirmed."]
    }
    do {
      return try addCapture(state,nil)
    }
    catch {
      state["error"]=["code":"computer_post_action_capture_failed","message":"Input dispatch settled but its subsequent capture failed; inspect before repeating input."]
      return state
    }
  }
  catch {
    let code=(error as? NativeFailure)?.code ?? "macos_native_operation_failed"
    state["error"]=["code":code,"message":"The native desktop operation could not complete."]
    if request["operation"] as? String=="act" {
      state["dispatch"]=dispatch ?? ["status":"not_dispatched","requestedInputCount":actionCount(request["action"] as? [String:Any] ?? [:]),"acceptedInputCount":0,"reason":code]
    }
    return state
  }
}
let operationQueue=DispatchQueue(label:"abot.computer.operations"),pendingLock=NSLock()
var cancellations=[String:CancellationFlag]()
func shutdownNativeHelper() {
  pendingLock.lock()
  for cancel in cancellations.values { cancel.cancel() }
  pendingLock.unlock()
  operationQueue.async { exit(0) }
}
signal(SIGTERM,SIG_IGN)
let terminationSource=DispatchSource.makeSignalSource(signal:SIGTERM,queue:.global())
terminationSource.setEventHandler { shutdownNativeHelper() }
terminationSource.resume()
DispatchQueue.global().async {
  while let line=readLine() {
    guard line.utf8.count<=65536,let data=line.data(using:.utf8),let message=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any] else {
      break
    }
    if message["type"] as? String=="close" {
      break
    }
    guard let id=message["id"] as? String else {
      break
    }
    if message["type"] as? String=="cancel" {
      pendingLock.lock()
      cancellations[id]?.cancel()
      pendingLock.unlock()
      continue
    }
    guard message["type"] as? String=="request",let request=message["request"] as? [String:Any] else {
      break
    }
    let cancel=CancellationFlag()
    pendingLock.lock()
    cancellations[id]=cancel
    pendingLock.unlock()
    operationQueue.async {
      emit(["type":"result","id":id,"result":perform(id,request,cancel)])
      pendingLock.lock()
      cancellations.removeValue(forKey:id)
      pendingLock.unlock()
    }
  }
  shutdownNativeHelper()
}
RunLoop.main.run()
`;
var MACOS_COMPUTER_HELPER = [
  MACOS_DESKTOP_SOURCE,
  MACOS_TOPOLOGY_SOURCE,
  MACOS_CAPTURE_SOURCE,
  MACOS_INPUT_SOURCE,
  MACOS_COMMAND_LOOP
].join("\n");

// src/computer-access/computer/macos-prerequisites.ts
var import_node_child_process3 = require("node:child_process");
var import_promises = require("node:fs/promises");
var import_node_util = require("node:util");
var executeFile = (0, import_node_util.promisify)(import_node_child_process3.execFile);
async function missingMacosComputerPrerequisite() {
  try {
    const version = await executeFile("/usr/bin/sw_vers", ["-productVersion"], {
      timeout: 1e3,
      maxBuffer: 1024
    });
    const major = Number(version.stdout.trim().split(".")[0]);
    if (!Number.isInteger(major) || major < 14)
      return "macos14_computer_backend_required";
    const directory = await executeFile("/usr/bin/xcode-select", ["-p"], {
      timeout: 1e3,
      maxBuffer: 4096
    });
    await (0, import_promises.access)(directory.stdout.trim());
    return void 0;
  } catch {
    return "macos_swift_developer_tools_required";
  }
}

// src/computer-access/computer/macos-backend.ts
function createMacosComputerBackend(target) {
  if (target.id !== "macos" || target.transport !== "native") {
    return {
      execute: async () => unavailableUnixDesktop("macos", "computer_native_target_required"),
      close: async () => {
      }
    };
  }
  const native = createUnixNativeProcess({
    platform: "macos",
    file: "/usr/bin/swift",
    args: ["-swift-version", "5", "-e", MACOS_COMPUTER_HELPER]
  });
  let prerequisites;
  return {
    async execute(request, signal) {
      prerequisites ??= missingMacosComputerPrerequisite();
      const reason = await prerequisites;
      if (reason) return unavailableUnixDesktop("macos", reason);
      return native.execute(request, signal);
    },
    close: () => native.close()
  };
}

// src/computer-access/computer/linux-desktop.ts
var LINUX_DESKTOP_SOURCE = String.raw`
import sys, os, json, time, uuid, threading, queue, ctypes, struct, zlib, base64, datetime, math
MAX_PNG = 10 * 1024 * 1024
output_lock = threading.Lock()

class NativeFailure(Exception):

    def __init__(self, code):
        self.code = code
        super().__init__(code)

def emit(value):
    with output_lock:
        print(json.dumps(value, ensure_ascii=False, separators=(',', ':')), flush=True)

def cap(available, reason=None, supported=True):
    result = {'supported': supported, 'available': available}
    if not available and reason:
        result['reason'] = reason
    return result

def bounded_text(value, limit=256):
    return str(value).encode('utf-8')[:limit].decode('utf-8', 'ignore')

def desktop_result(platform, binding, bounds, available, capture, input_, windows, targeting):
    return {'desktop': {'platform': platform, 'binding': binding, 'name': 'User desktop', 'available': available, 'bounds': bounds, 'capabilities': {'capture': capture, 'input': input_, 'windows': windows, 'accessibility': cap(False, 'linux_accessibility_not_available')}, 'targetingGuarantee': targeting}, 'windows': []}

def failed_desktop(code):
    return desktop_result('linux', 'unavailable:linux', {'x': 0, 'y': 0, 'width': 1, 'height': 1}, False, cap(False, code), cap(False, code), cap(False, code), 'observed_surface')

def targeting_guarantee_for_focus(focused):
    if not focused:
        return 'observed_surface'
    return 'verified_window'

def require_observation_source(request, state):
    if request.get('region') is None and request.get('operation') != 'act':
        return
    if request.get('desktopBinding') != state['desktop']['binding']:
        raise NativeFailure('computer_desktop_stale')
    if request.get('expectedGeometry') != state['desktop']['bounds']:
        raise NativeFailure('computer_geometry_changed')

def encode_png(width, height, scanlines):

    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data) & 4294967295)
    image = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(scanlines, 3)) + chunk(b'IEND', b'')
    if len(image) > MAX_PNG:
        raise NativeFailure('computer_capture_size_limit')
    return image

def point_inside(point, bounds):
    if not all((isinstance(point.get(axis), (int, float)) and math.isfinite(point[axis]) for axis in ['x', 'y'])):
        return False
    return bounds['x'] <= point['x'] < bounds['x'] + bounds['width'] and bounds['y'] <= point['y'] < bounds['y'] + bounds['height']

def capture_region(region, bounds):
    if region is None:
        return bounds.copy()
    if not all((isinstance(region.get(key), (int, float)) and math.isfinite(region[key]) for key in ['x', 'y', 'width', 'height'])):
        raise NativeFailure('computer_region_invalid')
    if region['width'] < 1 or region['height'] < 1:
        raise NativeFailure('computer_region_invalid')
    if not point_inside({'x': region['x'], 'y': region['y']}, bounds):
        raise NativeFailure('computer_region_outside_desktop')
    if region['x'] + region['width'] > bounds['x'] + bounds['width'] or region['y'] + region['height'] > bounds['y'] + bounds['height']:
        raise NativeFailure('computer_region_outside_desktop')
    return {key: round(region[key]) for key in ['x', 'y', 'width', 'height']}

def session_locked():
    try:
        from gi.repository import Gio, GLib
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        for service, path in [('org.freedesktop.ScreenSaver', '/org/freedesktop/ScreenSaver'), ('org.gnome.ScreenSaver', '/org/gnome/ScreenSaver')]:
            try:
                result = bus.call_sync(service, path, service, 'GetActive', None, None, Gio.DBusCallFlags.NONE, 1000, None)
                return bool(result.unpack()[0])
            except Exception:
                pass
        return None
    except Exception:
        return None

def read_accessibility(expected_window):
    try:
        import pyatspi
    except ImportError:
        return ([], False, False)
    nodes = []
    pending = []
    started = time.monotonic()
    total = 0
    try:
        expected_pid = int(expected_window['binding'].split(':')[-1])
        if expected_pid <= 0:
            return ([], False, False)
        for app in pyatspi.Registry.getDesktop(0):
            if int(app.get_process_id()) != expected_pid:
                continue
            for window in app:
                if not window.getState().contains(pyatspi.STATE_ACTIVE):
                    continue
                if bounded_text(window.name or '', 128) != expected_window['title']:
                    continue
                pending.append(window)
        if len(pending) != 1:
            return ([], False, False)
        visited = 0
        while pending and visited < 400 and (len(nodes) < 64) and (total < 24000) and (time.monotonic() - started < 0.4):
            item = pending.pop(0)
            visited += 1
            if item.getRole() == pyatspi.ROLE_PASSWORD_TEXT or not item.getState().contains(pyatspi.STATE_SHOWING):
                continue
            node = {'role': bounded_text(item.getRoleName(), 64), 'name': bounded_text(item.name or '', 128), 'focused': item.getState().contains(pyatspi.STATE_FOCUSED)}
            if item.childCount == 0:
                try:
                    text = item.queryText()
                    node['value'] = bounded_text(text.getText(0, min(text.characterCount, 256)))
                except Exception:
                    pass
            total += len(node.get('name', '')) + len(node.get('value', ''))
            nodes.append(node)
            for child in item:
                if len(pending) < 400 and child is not None:
                    pending.append(child)
        return (nodes, bool(pending), True)
    except Exception:
        return (nodes, True, True)

def add_observation(backend, state, region=None):
    bounds = state['desktop']['bounds']
    region = capture_region(region, bounds)
    require_capture_source(state, backend.inspect())
    data, width, height = backend.capture(region)
    nodes, truncated, available = ([], False, False)
    reason = 'selected_surface_accessibility_unbound'
    focused = next((window for window in state['windows'] if window['binding'] == state.get('focusedWindow')), None)
    if focused:
        nodes, truncated, available = read_accessibility(focused)
        reason = 'linux_accessibility_source_unavailable'
    after = backend.inspect()
    require_capture_source_available(state, after)
    if state['desktop']['binding'] != after['desktop']['binding'] or bounds != after['desktop']['bounds']:
        raise NativeFailure('computer_geometry_changed_during_capture')
    if state.get('focusedWindow') != after.get('focusedWindow'):
        raise NativeFailure('computer_focus_changed_during_capture')
    state['desktop']['capabilities']['accessibility'] = cap(available, reason)
    state['observation'] = {'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'region': region, 'imageWidth': width, 'imageHeight': height, 'accessibility': nodes, 'accessibilityTruncated': truncated}
    state['imageBase64'] = base64.b64encode(data).decode('ascii')
    return state

def require_capture_source(expected, current):
    require_capture_source_available(expected, current)
    if expected['desktop']['binding'] != current['desktop']['binding']:
        raise NativeFailure('computer_desktop_stale')
    if expected['desktop']['bounds'] != current['desktop']['bounds']:
        raise NativeFailure('computer_geometry_changed')

def require_capture_source_available(expected, current):
    if current['desktop']['available']:
        return
    expected['desktop'] = current['desktop']
    raise NativeFailure(current['desktop'].get('reason') or 'computer_capture_source_unavailable')
`;

// src/computer-access/computer/linux-x11.ts
var LINUX_X11_SOURCE = String.raw`
class XImage(ctypes.Structure):
    _fields_ = [('width', ctypes.c_int), ('height', ctypes.c_int), ('xoffset', ctypes.c_int), ('format', ctypes.c_int), ('data', ctypes.c_void_p), ('byte_order', ctypes.c_int), ('bitmap_unit', ctypes.c_int), ('bitmap_bit_order', ctypes.c_int), ('bitmap_pad', ctypes.c_int), ('depth', ctypes.c_int), ('bytes_per_line', ctypes.c_int), ('bits_per_pixel', ctypes.c_int), ('red_mask', ctypes.c_ulong), ('green_mask', ctypes.c_ulong), ('blue_mask', ctypes.c_ulong)]

class X11Desktop:

    def __init__(self):
        self.x = ctypes.CDLL('libX11.so.6')
        self.t = None
        signatures = {'XOpenDisplay': ([ctypes.c_char_p], ctypes.c_void_p), 'XDefaultRootWindow': ([ctypes.c_void_p], ctypes.c_ulong), 'XInternAtom': ([ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int], ctypes.c_ulong), 'XGetWindowProperty': ([ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_long, ctypes.c_long, ctypes.c_int, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_void_p)], ctypes.c_int), 'XGetGeometry': ([ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint)], ctypes.c_int), 'XTranslateCoordinates': ([ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong)], ctypes.c_int), 'XGetImage': ([ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint, ctypes.c_ulong, ctypes.c_int], ctypes.POINTER(XImage)), 'XDestroyImage': ([ctypes.POINTER(XImage)], ctypes.c_int), 'XFree': ([ctypes.c_void_p], ctypes.c_int), 'XFlush': ([ctypes.c_void_p], ctypes.c_int), 'XCloseDisplay': ([ctypes.c_void_p], ctypes.c_int), 'XKeysymToKeycode': ([ctypes.c_void_p, ctypes.c_ulong], ctypes.c_ubyte), 'XStringToKeysym': ([ctypes.c_char_p], ctypes.c_ulong), 'XGetKeyboardMapping': ([ctypes.c_void_p, ctypes.c_ubyte, ctypes.c_int, ctypes.POINTER(ctypes.c_int)], ctypes.POINTER(ctypes.c_ulong)), 'XSetErrorHandler': ([ctypes.c_void_p], ctypes.c_void_p)}
        for name, (args, result) in signatures.items():
            function = getattr(self.x, name)
            function.argtypes = args
            function.restype = result
        self.error_callback = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)(lambda display, event: 0)
        self.x.XSetErrorHandler(self.error_callback)
        self.display = self.x.XOpenDisplay(None)
        if not self.display:
            raise NativeFailure('linux_x11_display_unavailable')
        self.root = self.x.XDefaultRootWindow(self.display)
        try:
            self.t = ctypes.CDLL('libXtst.so.6')
            self.t.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
            self.t.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
            self.t.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
            self.t.XTestQueryExtension.argtypes = [ctypes.c_void_p] + [ctypes.POINTER(ctypes.c_int)] * 4
            values = [ctypes.c_int() for _ in range(4)]
            if not self.t.XTestQueryExtension(self.display, *[ctypes.byref(value) for value in values]):
                self.t = None
        except OSError:
            self.t = None
        self.binding = 'x11:' + os.environ.get('XDG_SESSION_ID', 'session') + ':' + str(uuid.uuid4())
        try:
            self.topology = X11Topology(self)
        except Exception:
            self.x.XCloseDisplay(self.display)
            self.display = None
            raise

    def source_binding(self):
        return self.binding + ':' + self.topology.fingerprint()

    def focused_window_binding(self):
        active = self.property(self.root, '_NET_ACTIVE_WINDOW') or []
        if not active or not active[0]:
            return None
        pid = (self.property(active[0], '_NET_WM_PID') or [0])[0]
        return str(active[0]) + ':' + str(pid)

    def property(self, window, name):
        atom = self.x.XInternAtom(self.display, name.encode(), True)
        if not atom:
            return None
        actual, format_, count, remaining = (ctypes.c_ulong(), ctypes.c_int(), ctypes.c_ulong(), ctypes.c_ulong())
        data = ctypes.c_void_p()
        status = self.x.XGetWindowProperty(self.display, window, atom, 0, 16384, False, 0, ctypes.byref(actual), ctypes.byref(format_), ctypes.byref(count), ctypes.byref(remaining), ctypes.byref(data))
        if status or not data:
            return None
        try:
            if format_.value == 8:
                return ctypes.string_at(data, count.value).decode('utf-8', 'replace')
            if format_.value == 32:
                return list(ctypes.cast(data, ctypes.POINTER(ctypes.c_ulong))[:count.value])
            return None
        finally:
            self.x.XFree(data)

    def geometry(self, window):
        root, child = (ctypes.c_ulong(), ctypes.c_ulong())
        x, y = (ctypes.c_int(), ctypes.c_int())
        w, h, border, depth = (ctypes.c_uint(), ctypes.c_uint(), ctypes.c_uint(), ctypes.c_uint())
        if not self.x.XGetGeometry(self.display, window, ctypes.byref(root), ctypes.byref(x), ctypes.byref(y), ctypes.byref(w), ctypes.byref(h), ctypes.byref(border), ctypes.byref(depth)):
            return None
        if window != self.root:
            if not self.x.XTranslateCoordinates(self.display, window, self.root, 0, 0, ctypes.byref(x), ctypes.byref(y), ctypes.byref(child)):
                return None
        return {'x': x.value, 'y': y.value, 'width': w.value, 'height': h.value}

    def inspect(self):
        bounds = self.geometry(self.root)
        if not bounds:
            raise NativeFailure('linux_x11_geometry_unavailable')
        active = self.property(self.root, '_NET_ACTIVE_WINDOW') or []
        ids = self.property(self.root, '_NET_CLIENT_LIST_STACKING') or self.property(self.root, '_NET_CLIENT_LIST')
        windows = []
        for xid in (ids or [])[:64]:
            geometry = self.geometry(xid)
            if not geometry:
                continue
            pid = (self.property(xid, '_NET_WM_PID') or [0])[0]
            windows.append({'binding': str(xid) + ':' + str(pid), 'title': bounded_text(self.property(xid, '_NET_WM_NAME') or self.property(xid, 'WM_NAME') or '', 128), 'bounds': geometry, 'focused': bool(active and active[0] == xid)})
        result = desktop_result('linux', self.source_binding(), bounds, True, cap(True), cap(self.t is not None, 'linux_xtest_unavailable'), cap(ids is not None, 'linux_window_inventory_unavailable'), 'observed_surface')
        result['windows'] = windows
        result['desktop']['coordinateSpace'] = 'physical_pixels'
        for window in windows:
            if window['focused']:
                result['focusedWindow'] = window['binding']
        result['desktop']['targetingGuarantee'] = targeting_guarantee_for_focus(result.get('focusedWindow'))
        return result

    def capture(self, region):
        image = self.x.XGetImage(self.display, self.root, int(region['x']), int(region['y']), int(region['width']), int(region['height']), ctypes.c_ulong(-1).value, 2)
        if not image:
            raise NativeFailure('linux_x11_capture_failed')
        try:
            info = image.contents
            if info.bits_per_pixel not in (16, 24, 32):
                raise NativeFailure('linux_x11_pixel_format_unsupported')
            pixel_size = info.bits_per_pixel // 8
            source = ctypes.string_at(info.data, info.bytes_per_line * info.height)
            rows = []
            masks = [info.red_mask, info.green_mask, info.blue_mask]
            shifts = [(mask & -mask).bit_length() - 1 for mask in masks]
            maxima = [mask >> shift for mask, shift in zip(masks, shifts)]
            scale = min(1.0, 2048 / max(info.width, info.height))
            output_width = max(1, round(info.width * scale))
            output_height = max(1, round(info.height * scale))
            for output_row in range(output_height):
                row = min(info.height - 1, int(output_row / scale))
                line = bytearray([0])
                for output_column in range(output_width):
                    column = min(info.width - 1, int(output_column / scale))
                    offset = row * info.bytes_per_line + column * pixel_size
                    value = int.from_bytes(source[offset:offset + pixel_size], 'little' if info.byte_order == 0 else 'big')
                    line.extend((((value & mask) >> shift) * 255 // maximum for mask, shift, maximum in zip(masks, shifts, maxima)))
                rows.append(bytes(line))
            return (encode_png(output_width, output_height, b''.join(rows)), output_width, output_height)
        finally:
            self.x.XDestroyImage(image)

    def key(self, name):
        aliases = {'Ctrl': 'Control_L', 'Control': 'Control_L', 'Alt': 'Alt_L', 'Shift': 'Shift_L', 'Meta': 'Super_L', 'Super': 'Super_L', 'Command': 'Super_L', 'Enter': 'Return', 'Esc': 'Escape', 'Backspace': 'BackSpace', 'Space': 'space', 'ArrowLeft': 'Left', 'ArrowRight': 'Right', 'ArrowUp': 'Up', 'ArrowDown': 'Down', 'PageUp': 'Prior', 'PageDown': 'Next'}
        symbol = self.x.XStringToKeysym(aliases.get(name, name).encode('ascii', 'strict'))
        code = self.x.XKeysymToKeycode(self.display, symbol)
        if not symbol or not code:
            raise NativeFailure('linux_key_unmapped')
        return (int(code), False)

    def text_keys(self, text):
        self.x.XkbGetState.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p]
        self.x.XkbKeycodeToKeysym.argtypes = [ctypes.c_void_p, ctypes.c_ubyte, ctypes.c_int, ctypes.c_int]
        self.x.XkbKeycodeToKeysym.restype = ctypes.c_ulong
        state = (ctypes.c_ubyte * 256)()
        if self.x.XkbGetState(self.display, 0x100, ctypes.byref(state)) != 0:
            raise NativeFailure('linux_keyboard_state_unavailable')
        group, modifiers = state[0], state[6]
        if modifiers & (1 | 2 | 4 | 8 | 64):
            raise NativeFailure('linux_text_active_modifiers_unsupported')
        keys = []
        for character in text:
            symbol = {'\n': 65293, '\t': 65289}.get(character, ord(character) if ord(character) <= 255 else 16777216 | ord(character))
            code = self.x.XKeysymToKeycode(self.display, symbol)
            if not code:
                raise NativeFailure('linux_text_character_unmapped')
            plain = self.x.XkbKeycodeToKeysym(self.display, code, group, 0)
            shifted = self.x.XkbKeycodeToKeysym(self.display, code, group, 1)
            if plain == symbol:
                keys.append((int(code), False))
                continue
            if shifted == symbol:
                keys.append((int(code), True))
                continue
            raise NativeFailure('linux_text_character_unmapped')
        return keys

    def pointer(self, point):
        if not self.t.XTestFakeMotionEvent(self.display, -1, round(point['x']), round(point['y']), 0):
            raise NativeFailure('linux_xtest_pointer_rejected')
        self.x.XFlush(self.display)

    def button(self, button, down):
        if not self.t.XTestFakeButtonEvent(self.display, button, int(down), 0):
            raise NativeFailure('linux_xtest_button_rejected')
        self.x.XFlush(self.display)

    def key_event(self, key, down):
        if not self.t.XTestFakeKeyEvent(self.display, key, int(down), 0):
            raise NativeFailure('linux_xtest_key_rejected')
        self.x.XFlush(self.display)

    def scroll(self, x, y):
        for amount, positive, negative in [(y / 120, 5, 4), (x / 120, 7, 6)]:
            if abs(amount) > 100:
                raise NativeFailure('linux_scroll_limit')
            for _ in range(abs(round(amount))):
                self.button(positive if amount > 0 else negative, True)
                self.button(positive if amount > 0 else negative, False)

    def focus(self, binding):

        class XClientMessageData(ctypes.Union):
            _fields_ = [('b', ctypes.c_char * 20), ('s', ctypes.c_short * 10), ('l', ctypes.c_long * 5)]

        class XClientMessage(ctypes.Structure):
            _fields_ = [('type', ctypes.c_int), ('serial', ctypes.c_ulong), ('send_event', ctypes.c_int), ('display', ctypes.c_void_p), ('window', ctypes.c_ulong), ('message_type', ctypes.c_ulong), ('format', ctypes.c_int), ('data', XClientMessageData)]

        class XEvent(ctypes.Union):
            _fields_ = [('client', XClientMessage), ('pad', ctypes.c_long * 24)]
        event = XEvent()
        event.client.type = 33
        event.client.display = self.display
        event.client.window = int(binding.split(':')[0])
        event.client.message_type = self.x.XInternAtom(self.display, b'_NET_ACTIVE_WINDOW', False)
        event.client.format = 32
        event.client.data.l[0] = 2
        event.client.data.l[1] = 0
        self.x.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.POINTER(XEvent)]
        if not self.x.XSendEvent(self.display, self.root, False, 1 << 20 | 1 << 19, ctypes.byref(event)):
            raise NativeFailure('linux_window_focus_failed')
        self.x.XFlush(self.display)

    def close(self):
        if self.display:
            self.x.XCloseDisplay(self.display)
            self.display = None
`;

// src/computer-access/computer/linux-portal.ts
var LINUX_PORTAL_SOURCE = String.raw`
class PortalDesktop:
    BUS = 'org.freedesktop.portal.Desktop'
    PATH = '/org/freedesktop/portal/desktop'
    REMOTE = 'org.freedesktop.portal.RemoteDesktop'
    SCREEN = 'org.freedesktop.portal.ScreenCast'

    def __init__(self):
        import gi
        from gi.repository import Gio, GLib
        self.Gio, self.GLib = (Gio, GLib)
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.session = None
        self.fd = None
        self.pipeline = None
        self.sink = None
        self.stream = None
        self.geometry = {'x': 0, 'y': 0, 'width': 1, 'height': 1}
        self.binding = 'wayland:' + str(uuid.uuid4())
        self.devices = 0
        self.closed = False
        self.Gst = None
        self.remote_available = False
        self.capture_available = False
        self.capture_dimensions = None
        self.capture_layout = None
        self.invalidated_reason = None
        self.subscriptions = []
        try:
            devices = self.call('org.freedesktop.DBus.Properties', 'Get', GLib.Variant('(ss)', (self.REMOTE, 'AvailableDeviceTypes'))).unpack()[0]
            self.remote_available = bool(devices & 3)
        except Exception:
            pass
        try:
            gi.require_version('Gst', '1.0')
            gi.require_version('GstVideo', '1.0')
            from gi.repository import Gst, GstVideo
            self.GstVideo = GstVideo
            Gst.init(None)
            if all((Gst.ElementFactory.find(name) for name in ['pipewiresrc', 'videoconvert', 'appsink'])):
                self.Gst = Gst
            sources = self.call('org.freedesktop.DBus.Properties', 'Get', GLib.Variant('(ss)', (self.SCREEN, 'AvailableSourceTypes'))).unpack()[0]
            self.capture_available = bool(self.Gst and sources & 1)
        except Exception:
            pass

    def call(self, interface, method, parameters, path=None):
        return self.bus.call_sync(self.BUS, path or self.PATH, interface, method, parameters, None, self.Gio.DBusCallFlags.NONE, 5000, None)

    def request(self, interface, method, signature, args, options, cancel):
        token = 'abot_' + uuid.uuid4().hex
        options = dict(options)
        options['handle_token'] = self.GLib.Variant('s', token)
        sender = self.bus.get_unique_name().lstrip(':').replace('.', '_')
        path = '/org/freedesktop/portal/desktop/request/' + sender + '/' + token
        ready = threading.Event()
        result = {}

        def received(connection, sender, path, interface, signal, parameters, data):
            response, values = parameters.unpack()
            result.update({'response': response, 'values': values})
            ready.set()
        subscription = self.bus.signal_subscribe(self.BUS, 'org.freedesktop.portal.Request', 'Response', path, None, self.Gio.DBusSignalFlags.NONE, received, None)
        try:
            self.call(interface, method, self.GLib.Variant(signature, tuple(args) + (options,)))
            deadline = time.monotonic() + 30
            while not ready.wait(0.05):
                if cancel.is_set() or time.monotonic() > deadline:
                    try:
                        self.call('org.freedesktop.portal.Request', 'Close', None, path)
                    except Exception:
                        pass
                    raise NativeFailure('linux_portal_request_cancelled')
            if result['response'] != 0:
                raise NativeFailure('linux_portal_permission_denied')
            return result['values']
        finally:
            self.bus.signal_unsubscribe(subscription)

    def ensure_session(self, cancel):
        if self.closed:
            raise NativeFailure('linux_portal_session_closed')
        if self.session:
            return
        if not self.capture_available:
            raise NativeFailure('linux_pipewire_capture_dependencies_unavailable')
        session_interface = self.REMOTE if self.remote_available else self.SCREEN
        session_token = 'abot_' + uuid.uuid4().hex
        created = self.request(session_interface, 'CreateSession', '(a{sv})', [], {'session_handle_token': self.GLib.Variant('s', session_token)}, cancel)
        self.session = created['session_handle']

        def session_closed(*args):
            self.closed = True
        self.subscriptions.append(self.bus.signal_subscribe(self.BUS, 'org.freedesktop.portal.Session', 'Closed', self.session, None, self.Gio.DBusSignalFlags.NONE, session_closed, None))
        try:
            if self.remote_available:
                self.request(self.REMOTE, 'SelectDevices', '(oa{sv})', [self.session], {'types': self.GLib.Variant('u', 3)}, cancel)
            self.request(self.SCREEN, 'SelectSources', '(oa{sv})', [self.session], {'types': self.GLib.Variant('u', 1), 'multiple': self.GLib.Variant('b', False)}, cancel)
            started = self.request(session_interface, 'Start', '(osa{sv})', [self.session, ''], {}, cancel)
            self.devices = started.get('devices', 0)
            streams = started.get('streams', [])
            if len(streams) != 1:
                raise NativeFailure('linux_portal_single_monitor_required')
            self.stream, properties = streams[0]
            size = properties.get('size')
            if not size or size[0] <= 0 or size[1] <= 0:
                raise NativeFailure('linux_portal_geometry_unavailable')
            self.geometry = {'x': 0, 'y': 0, 'width': size[0], 'height': size[1]}
            returned, fds = self.bus.call_with_unix_fd_list_sync(self.BUS, self.PATH, self.SCREEN, 'OpenPipeWireRemote', self.GLib.Variant('(oa{sv})', (self.session, {})), None, self.Gio.DBusCallFlags.NONE, 5000, None, None)
            self.fd = fds.get(returned.unpack()[0])
            self.pipeline = self.Gst.Pipeline.new('abot-capture')
            source = self.Gst.ElementFactory.make('pipewiresrc', 'source')
            source.set_property('fd', self.fd)
            self.binding = bind_portal_capture_source(self, source, properties)
            convert = self.Gst.ElementFactory.make('videoconvert', 'convert')
            self.sink = self.Gst.ElementFactory.make('appsink', 'sink')
            self.sink.set_property('caps', self.Gst.Caps.from_string('video/x-raw,format=RGB'))
            self.sink.set_property('max-buffers', 1)
            self.sink.set_property('drop', True)
            self.sink.set_property('sync', False)
            for element in [source, convert, self.sink]:
                self.pipeline.add(element)
            if not source.link(convert) or not convert.link(self.sink):
                raise NativeFailure('linux_pipewire_pipeline_failed')
            self.pipeline.set_state(self.Gst.State.PLAYING)
        except Exception:
            self.close()
            raise

    def inspect(self):
        self.validate_stream_dimensions()
        active = not self.closed and (self.remote_available or self.capture_available)
        capture_reason = 'linux_portal_permission_required' if self.capture_available else 'linux_pipewire_capture_dependencies_unavailable'
        input_reason = 'linux_portal_permission_required' if self.remote_available else 'linux_remote_desktop_portal_unavailable'
        has_granted_session = bool(self.session and not self.closed)
        result = desktop_result('linux', self.binding, self.geometry, active, cap(self.capture_available and has_granted_session, capture_reason), cap(self.remote_available and has_granted_session, input_reason), cap(False, 'wayland_window_inventory_unavailable', False), 'observed_surface')
        result['desktop']['coordinateSpace'] = 'logical_points'
        if self.closed:
            result['desktop']['reason'] = self.invalidated_reason or 'linux_portal_session_closed'
        if self.session:
            denied_input = 'linux_portal_input_permission_partial' if self.remote_available else 'linux_remote_desktop_portal_unavailable'
            result['desktop']['capabilities']['input'] = cap(has_granted_session and self.devices & 3 == 3, self.invalidated_reason or denied_input)
        return result

    def source_binding(self):
        self.validate_stream_dimensions()
        if self.closed:
            raise NativeFailure(self.invalidated_reason or 'linux_portal_session_closed')
        return self.binding

    def validate_stream_dimensions(self):
        require_portal_stream_alive(self)
        if not getattr(self, 'sink', None):
            return
        pad = self.sink.get_static_pad('sink')
        caps = pad.get_current_caps() if pad else None
        if not caps:
            return
        require_portal_frame_layout(self, caps)
        structure = caps.get_structure(0)
        dimensions = (structure.get_value('width'), structure.get_value('height'))
        if self.capture_dimensions is not None and self.capture_dimensions != dimensions:
            self.closed = True
            self.invalidated_reason = 'linux_portal_geometry_changed'

    def capture(self, region):
        self.validate_stream_dimensions()
        if self.closed or not self.sink:
            raise NativeFailure('linux_portal_session_unavailable')
        sample = fresh_portal_sample(self)
        require_portal_stream_alive(self)
        require_portal_frame_layout(self, sample.get_caps())
        if self.closed:
            raise NativeFailure(self.invalidated_reason or 'linux_portal_session_closed')
        structure = sample.get_caps().get_structure(0)
        width, height = (structure.get_value('width'), structure.get_value('height'))
        dimensions = (width, height)
        if self.capture_dimensions is not None and dimensions != self.capture_dimensions:
            self.closed = True
            self.invalidated_reason = 'linux_portal_geometry_changed'
            raise NativeFailure(self.invalidated_reason)
        self.capture_dimensions = dimensions
        self.capture_layout = portal_frame_layout(sample.get_caps())
        buffer = sample.get_buffer()
        success, mapped = buffer.map(self.Gst.MapFlags.READ)
        if not success:
            raise NativeFailure('linux_pipewire_frame_unavailable')
        try:
            info = self.GstVideo.VideoInfo.new_from_caps(sample.get_caps())
            if info is None:
                raise NativeFailure('linux_pipewire_pixel_format_unsupported')
            sx = width / self.geometry['width']
            sy = height / self.geometry['height']
            x, y = (round(region['x'] * sx), round(region['y'] * sy))
            w, h = (round(region['width'] * sx), round(region['height'] * sy))
            scale = min(1.0, 2048 / max(w, h))
            output_width, output_height = max(1, round(w * scale)), max(1, round(h * scale))
            rows = []
            for output_row in range(output_height):
                row = y + min(h - 1, int(output_row / scale))
                offset = info.offset[0] + row * info.stride[0] + x * 3
                line = bytearray([0])
                for output_column in range(output_width):
                    column = min(w - 1, int(output_column / scale))
                    line.extend(mapped.data[offset + column * 3:offset + column * 3 + 3])
                rows.append(bytes(line))
            return (encode_png(output_width, output_height, b''.join(rows)), output_width, output_height)
        finally:
            buffer.unmap(mapped)

    def notify(self, method, signature, values):
        self.validate_stream_dimensions()
        if self.closed or not self.session:
            raise NativeFailure('linux_portal_session_closed')
        self.call(self.REMOTE, method, self.GLib.Variant(signature, (self.session, {}) + tuple(values)))

    def pointer(self, point):
        self.notify('NotifyPointerMotionAbsolute', '(oa{sv}udd)', [self.stream, float(point['x']), float(point['y'])])

    def button(self, button, down):
        self.notify('NotifyPointerButton', '(oa{sv}iu)', [{1: 272, 2: 274, 3: 273}[button], int(down)])

    def scroll(self, x, y):
        if x % 120 or y % 120:
            raise NativeFailure('linux_wayland_scroll_fraction_unsupported')
        if x:
            self.notify('NotifyPointerAxisDiscrete', '(oa{sv}ui)', [1, int(x / 120)])
        if y:
            self.notify('NotifyPointerAxisDiscrete', '(oa{sv}ui)', [0, int(y / 120)])

    def key_event(self, key, down):
        self.notify('NotifyKeyboardKeysym', '(oa{sv}iu)', [key, int(down)])

    def key(self, name):
        aliases = {'Ctrl': 65507, 'Control': 65507, 'Alt': 65513, 'Shift': 65505, 'Meta': 65515, 'Super': 65515, 'Command': 65515, 'Enter': 65293, 'Escape': 65307, 'Esc': 65307, 'Tab': 65289, 'Backspace': 65288, 'Delete': 65535, 'Space': 32, 'ArrowLeft': 65361, 'ArrowUp': 65362, 'ArrowRight': 65363, 'ArrowDown': 65364, 'Home': 65360, 'End': 65367, 'PageUp': 65365, 'PageDown': 65366}
        if name in aliases:
            return (aliases[name], False)
        if len(name) == 1:
            return (ord(name) if ord(name) <= 255 else 16777216 | ord(name), False)
        if name.startswith('F') and name[1:].isdigit() and (1 <= int(name[1:]) <= 24):
            return (65469 + int(name[1:]), False)
        raise NativeFailure('linux_key_unmapped')

    def text_keys(self, text):
        return [self.key({'\n': 'Enter', '\t': 'Tab'}.get(char, char)) for char in text]

    def focus(self, binding):
        raise NativeFailure('wayland_window_focus_unavailable')

    def close(self):
        self.closed = True
        if self.pipeline:
            self.pipeline.set_state(self.Gst.State.NULL)
            self.pipeline = None
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
        if self.session:
            try:
                self.call('org.freedesktop.portal.Session', 'Close', None, self.session)
            except Exception:
                pass
        for subscription in self.subscriptions:
            self.bus.signal_unsubscribe(subscription)
        self.subscriptions = []
        self.session = None
`;

// src/computer-access/computer/linux-input.ts
var LINUX_INPUT_SOURCE = String.raw`
def incomplete_dispatch_error(dispatch):
    status = dispatch['status']
    if status == 'partial':
        return {'code': 'computer_input_partial', 'message': 'Native input was only partially dispatched. Inspect the receipt and fresh observation before another action.'}
    if status == 'unknown':
        return {'code': 'computer_input_unknown', 'message': 'Native input dispatch is uncertain. Inspect the receipt and fresh observation before another action.'}
    return None

def action_input_count(action):
    kind = action.get('kind')
    if kind == 'type_text':
        return len(action.get('text', '')) * 2
    if kind == 'press_keys':
        return len(action.get('keys', [])) * 2
    if kind == 'click':
        return 1 + action.get('count', 1) * 2
    if kind == 'drag':
        return 15
    return 1

def validate_action(action, state, backend):
    kind = action.get('kind')
    if kind not in ['click', 'move', 'drag', 'scroll', 'type_text', 'press_keys', 'focus_window']:
        raise NativeFailure('computer_action_unsupported')
    bounds = state['desktop']['bounds']
    points = []
    if kind in ['click', 'move']:
        points = [action['point']]
    if kind == 'drag':
        points = [action['from'], action['to']]
    for point in points:
        if not point_inside(point, bounds):
            raise NativeFailure('computer_point_outside_desktop')
    if kind == 'click' and action.get('count') not in [1, 2]:
        raise NativeFailure('computer_click_count_invalid')
    if kind in ['click', 'drag'] and action.get('button') not in ['left', 'middle', 'right']:
        raise NativeFailure('computer_button_invalid')
    if kind == 'drag' and (not 0 <= action.get('durationMs', -1) <= 5000):
        raise NativeFailure('computer_drag_duration_invalid')
    if kind == 'scroll':
        values = [action.get('deltaX'), action.get('deltaY')]
        if not all((isinstance(value, (int, float)) and math.isfinite(value) and (abs(value) <= 12000) for value in values)):
            raise NativeFailure('computer_scroll_limit')
        if any((value % 120 for value in values)):
            raise NativeFailure('linux_scroll_fraction_unsupported')
    if kind == 'type_text':
        if not isinstance(action.get('text'), str) or len(action['text']) > 10000:
            raise NativeFailure('computer_text_limit')
        return backend.text_keys(action['text'])
    if kind == 'press_keys':
        if not isinstance(action.get('keys'), list) or not 1 <= len(action['keys']) <= 8:
            raise NativeFailure('computer_keys_invalid')
        return [backend.key(key) for key in action['keys']]
    if kind == 'focus_window':
        if not state['desktop']['capabilities']['windows']['available']:
            raise NativeFailure('computer_window_focus_unavailable')
        if not any((window['binding'] == action.get('windowBinding') for window in state['windows'])):
            raise NativeFailure('computer_window_stale')
    return []

def require_verified_text_focus(backend, action, expected_window):
    if action['kind'] != 'type_text':
        return
    if expected_window is None:
        return
    if backend.focused_window_binding() != expected_window:
        raise NativeFailure('computer_focus_changed')

def execute_input(backend, action, keys, cancel, deadline, id, expected_binding, expected_window=None):
    count = action_input_count(action)
    if action['kind'] == 'type_text':
        count = sum(4 if shift else 2 for key, shift in keys)
    accepted = 0
    held_keys = []
    held_buttons = []

    def check():
        if cancel.is_set():
            raise NativeFailure('computer_action_cancelled')
        if time.time() * 1000 > deadline:
            raise NativeFailure('computer_action_deadline')
        require_verified_text_focus(backend, action, expected_window)

    def event(function, *args):
        nonlocal accepted
        check()
        function(*args)
        accepted += 1

    def down_key(key):
        event(backend.key_event, key, True)
        held_keys.append(key)

    def up_key(key):
        nonlocal accepted
        backend.key_event(key, False)
        held_keys.remove(key)
        accepted += 1

    def down_button(button):
        event(backend.button, button, True)
        held_buttons.append(button)

    def up_button(button):
        nonlocal accepted
        backend.button(button, False)
        held_buttons.remove(button)
        accepted += 1
    check()
    if backend.source_binding() != expected_binding:
        raise NativeFailure('computer_desktop_stale')
    emit({'type': 'dispatch', 'id': id, 'dispatch': {'status': 'unknown', 'requestedInputCount': count, 'reason': 'native_dispatch_started'}})
    failure = None
    try:
        kind = action['kind']
        if kind == 'move':
            event(backend.pointer, action['point'])
        if kind == 'click':
            event(backend.pointer, action['point'])
            button = {'left': 1, 'middle': 2, 'right': 3}[action['button']]
            for index in range(action['count']):
                check()
                down_button(button)
                up_button(button)
                if index + 1 < action['count']:
                    cancel.wait(0.05)
        if kind == 'drag':
            event(backend.pointer, action['from'])
            button = {'left': 1, 'middle': 2, 'right': 3}[action['button']]
            down_button(button)
            for step in range(1, 13):
                point = {axis: action['from'][axis] + (action['to'][axis] - action['from'][axis]) * step / 12 for axis in ['x', 'y']}
                event(backend.pointer, point)
                cancel.wait(action['durationMs'] / 12000)
            check()
            up_button(button)
        if kind == 'scroll':
            event(backend.scroll, action['deltaX'], action['deltaY'])
        if kind == 'focus_window':
            event(backend.focus, action['windowBinding'])
        if kind == 'press_keys':
            for key, shift in keys:
                down_key(key)
            for key, shift in reversed(keys):
                up_key(key)
        if kind == 'type_text':
            for key, shift in keys:
                check()
                if shift:
                    down_key(backend.key('Shift')[0])
                down_key(key)
                up_key(key)
                if shift:
                    up_key(backend.key('Shift')[0])
    except Exception as error:
        failure = error
    finally:
        for key in reversed(held_keys):
            try:
                backend.key_event(key, False)
            except Exception:
                failure = NativeFailure('computer_key_release_uncertain')
        for button in reversed(held_buttons):
            try:
                backend.button(button, False)
            except Exception:
                failure = NativeFailure('computer_button_release_uncertain')
    dispatch = {'status': 'accepted' if failure is None else 'partial' if accepted else 'unknown', 'requestedInputCount': count, 'acceptedInputCount': accepted}
    if failure is not None:
        dispatch['reason'] = failure.code if isinstance(failure, NativeFailure) else 'computer_native_action_failed'
    return dispatch
`;

// src/computer-access/computer/linux-frame.ts
var LINUX_FRAME_SOURCE = String.raw`
def fresh_portal_sample(backend):
    clock = backend.pipeline.get_clock()
    if clock is None:
        raise NativeFailure('linux_pipewire_clock_unavailable')
    cutoff = max(0, clock.get_time() - backend.pipeline.get_base_time())
    for _ in range(4):
        cached = backend.sink.emit('try-pull-sample', 0)
        if cached is None:
            break
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        sample = backend.sink.emit('try-pull-sample', int(0.2 * backend.Gst.SECOND))
        if sample is None:
            continue
        buffer = sample.get_buffer()
        if buffer.pts == backend.Gst.CLOCK_TIME_NONE:
            continue
        segment = sample.get_segment()
        if segment is None:
            continue
        timestamp = segment.to_running_time(backend.Gst.Format.TIME, buffer.pts)
        if timestamp == backend.Gst.CLOCK_TIME_NONE:
            continue
        if timestamp >= cutoff:
            return sample
    raise NativeFailure('linux_pipewire_fresh_frame_unavailable')
`;

// src/computer-access/computer/linux-topology.ts
var LINUX_TOPOLOGY_SOURCE = String.raw`
import hashlib

def source_fingerprint(records):
    canonical = sorted(json.dumps(record, sort_keys=True, separators=(',', ':')) for record in records)
    return hashlib.sha256(json.dumps(canonical, separators=(',', ':')).encode()).hexdigest()

class RandrResources(ctypes.Structure):
    _fields_ = [('timestamp', ctypes.c_ulong), ('configTimestamp', ctypes.c_ulong), ('ncrtc', ctypes.c_int), ('crtcs', ctypes.POINTER(ctypes.c_ulong)), ('noutput', ctypes.c_int), ('outputs', ctypes.POINTER(ctypes.c_ulong)), ('nmode', ctypes.c_int), ('modes', ctypes.c_void_p)]

class RandrCrtc(ctypes.Structure):
    _fields_ = [('timestamp', ctypes.c_ulong), ('x', ctypes.c_int), ('y', ctypes.c_int), ('width', ctypes.c_uint), ('height', ctypes.c_uint), ('mode', ctypes.c_ulong), ('rotation', ctypes.c_ushort), ('noutput', ctypes.c_int), ('outputs', ctypes.POINTER(ctypes.c_ulong)), ('rotations', ctypes.c_ushort), ('npossible', ctypes.c_int), ('possible', ctypes.POINTER(ctypes.c_ulong))]

class RandrTransform(ctypes.Structure):
    _fields_ = [('pending', ctypes.c_int32 * 9), ('pendingFilter', ctypes.c_void_p), ('pendingCount', ctypes.c_int), ('pendingParams', ctypes.c_void_p), ('current', ctypes.c_int32 * 9), ('currentFilter', ctypes.c_void_p), ('currentCount', ctypes.c_int), ('currentParams', ctypes.c_void_p)]

class X11Topology:
    def __init__(self, desktop):
        self.desktop = desktop
        try:
            self.r = ctypes.CDLL('libXrandr.so.2')
            signatures = {
                'XRRQueryVersion': ([ctypes.c_void_p, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int)], ctypes.c_int),
                'XRRGetScreenResourcesCurrent': ([ctypes.c_void_p, ctypes.c_ulong], ctypes.POINTER(RandrResources)),
                'XRRFreeScreenResources': ([ctypes.POINTER(RandrResources)], None),
                'XRRGetCrtcInfo': ([ctypes.c_void_p, ctypes.POINTER(RandrResources), ctypes.c_ulong], ctypes.POINTER(RandrCrtc)),
                'XRRFreeCrtcInfo': ([ctypes.POINTER(RandrCrtc)], None),
                'XRRGetCrtcTransform': ([ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.POINTER(RandrTransform))], ctypes.c_int),
            }
            for name, (args, result) in signatures.items():
                function = getattr(self.r, name)
                function.argtypes, function.restype = args, result
            major, minor = ctypes.c_int(), ctypes.c_int()
            if not self.r.XRRQueryVersion(desktop.display, ctypes.byref(major), ctypes.byref(minor)):
                raise NativeFailure('linux_randr_topology_unavailable')
            if (major.value, minor.value) < (1, 3):
                raise NativeFailure('linux_randr13_required')
        except (OSError, AttributeError):
            raise NativeFailure('linux_randr_topology_unavailable')

    def resources(self):
        resources = self.r.XRRGetScreenResourcesCurrent(self.desktop.display, self.desktop.root)
        if not resources:
            raise NativeFailure('linux_randr_topology_unavailable')
        return resources

    def crtc_record(self, resources, identifier):
        pointer = self.r.XRRGetCrtcInfo(self.desktop.display, resources, identifier)
        if not pointer:
            raise NativeFailure('linux_randr_topology_unavailable')
        try:
            info = pointer.contents
            if info.mode == 0:
                return None
            if not 1 <= info.noutput <= 256:
                raise NativeFailure('linux_randr_topology_unavailable')
            transform = ctypes.POINTER(RandrTransform)()
            if not self.r.XRRGetCrtcTransform(self.desktop.display, identifier, ctypes.byref(transform)) or not transform:
                raise NativeFailure('linux_randr_transform_unavailable')
            try:
                matrix = list(transform.contents.current)
            finally:
                self.desktop.x.XFree(transform)
            return {'crtc': identifier, 'outputs': sorted(info.outputs[:info.noutput]), 'rect': [info.x, info.y, info.width, info.height], 'mode': info.mode, 'rotation': info.rotation, 'transform': matrix}
        finally:
            self.r.XRRFreeCrtcInfo(pointer)

    def fingerprint(self):
        resources = self.resources()
        try:
            info = resources.contents
            epoch = (info.timestamp, info.configTimestamp)
            if not 1 <= info.ncrtc <= 256:
                raise NativeFailure('linux_randr_topology_unavailable')
            records = []
            for identifier in info.crtcs[:info.ncrtc]:
                record = self.crtc_record(resources, identifier)
                if record is not None:
                    records.append(record)
            if not records:
                raise NativeFailure('linux_randr_topology_unavailable')
            current = self.resources()
            try:
                if epoch != (current.contents.timestamp, current.contents.configTimestamp):
                    raise NativeFailure('computer_topology_changed')
            finally:
                self.r.XRRFreeScreenResources(current)
            return source_fingerprint([{'epoch': epoch}] + records)
        finally:
            self.r.XRRFreeScreenResources(resources)
`;

// src/computer-access/computer/linux-portal-source.ts
var LINUX_PORTAL_SOURCE_IDENTITY = String.raw`
def bind_portal_capture_source(backend, source, properties):
    serial = properties.get('pipewire-serial')
    if serial is not None:
        if not source.find_property('target-object'):
            raise NativeFailure('linux_pipewire_stable_target_unavailable')
        source.set_property('target-object', str(serial))
    else:
        source.set_property('path', str(backend.stream))
    # Legacy pipewiresrc connects with DONT_RECONNECT; never rebuild this pipeline after loss.
    if source.find_property('on-disconnect'):
        backend.Gst.util_set_object_arg(source, 'on-disconnect', 'error')
    selected = {key: properties[key] for key in ['id', 'mapping_id', 'pipewire-serial', 'position', 'size', 'source_type'] if key in properties}
    return 'wayland:' + source_fingerprint([{'session': backend.session, 'node': backend.stream, 'source': selected, 'geometry': backend.geometry}])

def require_portal_stream_alive(backend):
    pipeline = getattr(backend, 'pipeline', None)
    if pipeline is None:
        return
    kinds = backend.Gst.MessageType
    for _ in range(64):
        message = pipeline.get_bus().pop_filtered(kinds.ERROR | kinds.EOS | kinds.TAG)
        if message is None:
            return
        if message.type == kinds.TAG:
            present, orientation = message.parse_tag().get_string('image-orientation')
            if present:
                require_portal_orientation(backend, orientation)
            continue
        backend.closed = True
        backend.invalidated_reason = 'linux_portal_source_changed'
        return
    backend.closed = True
    backend.invalidated_reason = 'linux_portal_source_status_unavailable'

def require_portal_orientation(backend, orientation):
    previous = getattr(backend, 'source_orientation', None)
    backend.source_orientation = orientation
    if previous is None:
        return
    if getattr(backend, 'capture_layout', None) is None:
        return
    if previous == orientation:
        return
    backend.closed = True
    backend.invalidated_reason = 'linux_portal_geometry_changed'

def portal_frame_layout(caps):
    structure = caps.get_structure(0)
    return tuple(str(structure.get_value(key)) if structure.has_field(key) else '' for key in ['width', 'height', 'format', 'pixel-aspect-ratio', 'interlace-mode'])

def require_portal_frame_layout(backend, caps):
    expected = getattr(backend, 'capture_layout', None)
    if expected is None:
        return
    current = portal_frame_layout(caps)
    if current == expected:
        return
    backend.closed = True
    backend.invalidated_reason = 'linux_portal_geometry_changed'
`;

// src/computer-access/computer/linux-helper.ts
var LINUX_COMMAND_LOOP = String.raw`
backend = None
backend_error = None
jobs = queue.Queue()
cancellations = {}
stopping = threading.Event()

def get_backend():
    global backend, backend_error
    if backend is not None:
        return backend
    if backend_error:
        raise NativeFailure(backend_error)
    try:
        if os.environ.get('WAYLAND_DISPLAY'):
            backend = PortalDesktop()
        elif os.environ.get('DISPLAY'):
            backend = X11Desktop()
        else:
            raise NativeFailure('linux_graphical_session_unavailable')
        return backend
    except NativeFailure as error:
        backend_error = error.code
        raise
    except (ImportError, OSError):
        backend_error = 'linux_native_dependencies_unavailable'
        raise NativeFailure(backend_error)

def operation(id, request, cancel):
    state = None
    dispatch = None
    try:
        if cancel.is_set():
            raise NativeFailure('computer_action_cancelled')
        native = get_backend()
        if isinstance(native, PortalDesktop) and request['operation'] != 'inspect':
            native.ensure_session(cancel)
        state = native.inspect()
        locked = session_locked()
        if locked is True:
            raise NativeFailure('computer_session_locked')
        if isinstance(native, X11Desktop) and locked is None:
            raise NativeFailure('linux_session_lock_state_unavailable')
        if request['operation'] == 'inspect':
            return state
        if request['operation'] == 'observe':
            require_observation_source(request, state)
            return add_observation(native, state, request.get('region'))
        if request['operation'] != 'act':
            raise NativeFailure('computer_operation_unsupported')
        require_observation_source(request, state)
        if request.get('expectedWindow') and request['expectedWindow'] != state.get('focusedWindow'):
            raise NativeFailure('computer_focus_changed')
        if not state['desktop']['capabilities']['input']['available']:
            raise NativeFailure('computer_input_unavailable')
        keys = validate_action(request['action'], state, native)
        dispatch = execute_input(native, request['action'], keys, cancel, request['deadlineEpochMs'], id, request['desktopBinding'], request.get('expectedWindow'))
        emit({'type': 'dispatch', 'id': id, 'dispatch': dispatch})
        state = native.inspect()
        state['dispatch'] = dispatch
        require_observation_source(request, state)
        dispatch_error = incomplete_dispatch_error(dispatch)
        if dispatch_error:
            state['error'] = dispatch_error
        if request['action']['kind'] == 'focus_window' and state.get('focusedWindow') != request['action']['windowBinding']:
            state['error'] = {'code': 'computer_focus_not_confirmed', 'message': 'The window manager accepted the request but the target focus is not confirmed.'}
        try:
            return add_observation(native, state)
        except Exception:
            state['error'] = {'code': 'computer_post_action_capture_failed', 'message': 'Input dispatch settled but the subsequent capture failed; do not repeat the input without inspection.'}
            return state
    except Exception as error:
        code = error.code if isinstance(error, NativeFailure) else 'computer_native_operation_failed'
        state = state or failed_desktop(code)
        state['error'] = {'code': code, 'message': 'The native desktop operation could not complete.'}
        if request.get('operation') == 'act':
            state['dispatch'] = dispatch or {'status': 'not_dispatched', 'requestedInputCount': action_input_count(request.get('action', {})), 'acceptedInputCount': 0, 'reason': code}
        if code in ['computer_session_locked', 'linux_session_lock_state_unavailable']:
            state['desktop']['available'] = False
            state['desktop']['reason'] = code
            for capability in state['desktop']['capabilities'].values():
                capability.update({'available': False, 'reason': code})
        return state

def worker():
    while not stopping.is_set():
        value = jobs.get()
        if value is None:
            return
        id = value['id']
        cancel = cancellations[id]
        result = operation(id, value['request'], cancel)
        emit({'type': 'result', 'id': id, 'result': result})
        cancellations.pop(id, None)

worker_thread = None

def shutdown():
    if stopping.is_set():
        return
    stopping.set()
    for cancel in list(cancellations.values()):
        cancel.set()
    jobs.put(None)
    if worker_thread is not None:
        worker_thread.join(timeout=2)
    if backend is not None:
        try:
            backend.close()
        except Exception:
            pass
    os._exit(0)

def input_loop():
    for line in sys.stdin:
        try:
            if len(line) > 65536:
                break
            value = json.loads(line)
            if value['type'] == 'close':
                break
            if value['type'] == 'cancel':
                if value.get('id') in cancellations:
                    cancellations[value['id']].set()
                continue
            if value['type'] != 'request' or not isinstance(value.get('id'), str):
                break
            cancellations[value['id']] = threading.Event()
            jobs.put(value)
        except Exception:
            break
    shutdown()
if __name__ == '__main__':
    import signal
    signal.signal(signal.SIGTERM, lambda number, frame: threading.Thread(target=shutdown, daemon=True).start())
    worker_thread = threading.Thread(target=worker, daemon=True)
    worker_thread.start()
    threading.Thread(target=input_loop, daemon=True).start()
    try:
        from gi.repository import GLib
        GLib.MainLoop().run()
    except ImportError:
        stopping.wait()
`;
var LINUX_COMPUTER_HELPER = [
  LINUX_DESKTOP_SOURCE,
  LINUX_TOPOLOGY_SOURCE,
  LINUX_PORTAL_SOURCE_IDENTITY,
  LINUX_X11_SOURCE,
  LINUX_PORTAL_SOURCE,
  LINUX_INPUT_SOURCE,
  LINUX_FRAME_SOURCE,
  LINUX_COMMAND_LOOP
].join("\n");

// src/computer-access/computer/linux-backend.ts
function createLinuxComputerBackend(target) {
  if (target.id !== "linux" || target.transport !== "native") {
    return {
      execute: async () => unavailableUnixDesktop("linux", "computer_native_target_required"),
      close: async () => {
      }
    };
  }
  return createUnixNativeProcess({
    platform: "linux",
    file: "python3",
    args: ["-u", "-c", LINUX_COMPUTER_HELPER]
  });
}

// src/computer-access/computer/native-backend.ts
function createNativeComputerBackend(target) {
  if (target.id === "windows") return createWindowsComputerBackend(target);
  if (target.id === "macos") return createMacosComputerBackend(target);
  return createLinuxComputerBackend(target);
}

// src/computer-access/application-catalog.ts
var import_promises3 = require("node:fs/promises");
var import_node_os3 = require("node:os");
var import_node_path5 = require("node:path");

// src/computer-access/targets.ts
var import_node_fs4 = require("node:fs");
var import_promises2 = require("node:fs/promises");
var import_node_path4 = require("node:path");

// src/computer-access/process-runner.ts
var import_node_child_process4 = require("node:child_process");
var STREAM_MAX_CHARS = 16e3;
function runSystemProcess(input) {
  if (input.abortSignal?.aborted)
    return Promise.resolve({
      exitCode: null,
      stdout: "",
      stderr: "",
      status: "aborted",
      outputTruncated: false
    });
  return new Promise((resolve) => {
    const streamMaxChars = Math.min(
      input.outputMaxChars ?? STREAM_MAX_CHARS,
      512e3
    );
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;
    let status = "completed";
    let spawnedProcess;
    let timeout;
    let stopGrace;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (stopGrace) clearTimeout(stopGrace);
      input.abortSignal?.removeEventListener("abort", abort);
      resolve(
        Object.freeze({
          exitCode,
          stdout,
          stderr,
          status,
          outputTruncated: truncated,
          ...spawnedProcess ? { spawnedProcess } : {}
        })
      );
    };
    const child = (0, import_node_child_process4.spawn)(input.executable, [...input.args], {
      ...input.cwd ? { cwd: input.cwd } : {},
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32"
    });
    child.once("spawn", () => {
      if (child.pid === void 0) return;
      spawnedProcess = {
        pid: child.pid,
        pidNamespace: "runtime_os",
        executable: input.executable,
        identitySource: "spawn_arguments"
      };
    });
    const stop = (reason) => {
      if (settled) return;
      status = reason;
      const pid = child.pid;
      if (pid && process.platform !== "win32") {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGKILL");
      }
      stopGrace = setTimeout(() => finish(null), 1e3);
      stopGrace.unref();
    };
    const abort = () => stop("aborted");
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const remaining = streamMaxChars - stdout.length;
      truncated ||= chunk.length > remaining;
      stdout += chunk.slice(0, remaining);
    });
    child.stderr.on("data", (chunk) => {
      const remaining = streamMaxChars - stderr.length;
      truncated ||= chunk.length > remaining;
      stderr += chunk.slice(0, remaining);
    });
    child.once("error", (error) => {
      status = "spawn_failed";
      stderr = error.message.slice(0, STREAM_MAX_CHARS);
      finish(null);
    });
    child.once("close", (code) => finish(code));
    timeout = setTimeout(() => stop("timeout"), input.timeoutMs ?? 3e4);
    timeout.unref();
    input.abortSignal?.addEventListener("abort", abort, { once: true });
    if (input.abortSignal?.aborted) abort();
  });
}

// src/computer-access/host-observation.ts
var import_node_fs3 = require("node:fs");
var import_node_os2 = require("node:os");
function readSystemHostFacts() {
  return {
    platform: process.platform,
    kernelRelease: (0, import_node_os2.release)(),
    containerMarker: hasSystemContainerMarker()
  };
}
function hasSystemContainerMarker() {
  if ((0, import_node_fs3.existsSync)("/.dockerenv")) return true;
  return (0, import_node_fs3.existsSync)("/run/.containerenv");
}
function isContainerHostRuntime(facts) {
  if (facts.platform !== "linux") return false;
  return facts.containerMarker === true;
}
function isWslHostRuntime(facts) {
  if (facts.platform !== "linux") return false;
  if (isContainerHostRuntime(facts)) return false;
  return /microsoft/iu.test(facts.kernelRelease);
}
function runtimeOs(platform) {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  return "unsupported";
}
function observeSystemHost(facts = readSystemHostFacts()) {
  const runtime = runtimeOs(facts.platform);
  if (isContainerHostRuntime(facts)) return {
    runtimeOs: runtime,
    kernelRelease: facts.kernelRelease,
    environment: "container",
    inferredHostOs: "unknown",
    hostInferenceSource: "container_marker",
    windowsExecutionRequiresProbe: false,
    guiSessionStatus: "not_checked"
  };
  const wsl = isWslHostRuntime(facts);
  const inferredHostOs = wsl ? "windows" : runtime;
  return {
    runtimeOs: runtime,
    kernelRelease: facts.kernelRelease,
    environment: wsl ? "wsl_guest" : "not_identified_as_wsl",
    inferredHostOs,
    hostInferenceSource: wsl ? "wsl_kernel_signature" : "runtime_platform_only",
    windowsExecutionRequiresProbe: inferredHostOs === "windows",
    guiSessionStatus: "not_checked"
  };
}

// src/computer-access/targets.ts
function powershellArguments(script) {
  const preamble = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new();$global:LASTEXITCODE=0;";
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(preamble + script, "utf16le").toString("base64")
  ];
}
function powershellLiteral(value) {
  return "'" + value.replaceAll("'", "''") + "'";
}
function shellLiteral(value) {
  return "'" + value.replaceAll("'", `'"'"'`) + "'";
}
function windowsSystemCommandScript(command, cwd) {
  return `Set-Location -LiteralPath ${powershellLiteral(cwd)};${command}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`;
}
async function findExecutable(name, additional = []) {
  const candidates = [
    ...additional,
    ...(process.env.PATH ?? "").split(import_node_path4.delimiter).filter(Boolean).map((directory) => (0, import_node_path4.join)(directory, name))
  ];
  for (const candidate of candidates) {
    try {
      await (0, import_promises2.access)(candidate, import_node_fs4.constants.X_OK);
      return candidate;
    } catch {
    }
  }
  return void 0;
}
async function resolveSystemTarget(id, run = runSystemProcess) {
  if (isNativeUnixTarget(id)) return resolveNativeUnixTarget(id);
  if (id !== "windows")
    throw new SystemOperationError(
      "system_target_unavailable",
      `The runtime is not executing on ${id}.`
    );
  const nativeWindows = process.platform === "win32";
  const wslWindows = isWslHostRuntime(readSystemHostFacts());
  if (!hasWindowsExecutionTransport(nativeWindows, wslWindows))
    throw new SystemOperationError(
      "system_target_unavailable",
      "No Windows execution transport is available on this host."
    );
  const canonicalShell = nativeWindows ? (0, import_node_path4.join)(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  ) : "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
  const shell = await findExecutable("powershell.exe", [canonicalShell]);
  if (!shell)
    throw new SystemOperationError(
      "system_target_unavailable",
      "A native Windows PowerShell executable was not found; Windows interop is unavailable."
    );
  const probe = await run({
    executable: shell,
    args: powershellArguments("[Environment]::OSVersion.Platform.ToString()"),
    timeoutMs: 5e3
  });
  if (!hasObservedWindowsPlatform(probe))
    throw new SystemOperationError(
      "system_target_unavailable",
      "Windows PowerShell could not execute. WSL executable interop may be disabled; enable a real Windows execution transport on the host."
    );
  return { id, transport: nativeWindows ? "native" : "wsl_interop", shell };
}
function readSystemTargetId(value) {
  if (value === "linux" || value === "macos" || value === "windows")
    return value;
  throw new SystemOperationError(
    "system_target_required",
    "Select an explicit target returned by system_targets: linux, macos, or windows."
  );
}
function isNativeUnixTarget(id) {
  if (id === "linux") return process.platform === "linux";
  if (id === "macos") return process.platform === "darwin";
  return false;
}
async function resolveNativeUnixTarget(id) {
  try {
    await (0, import_promises2.access)("/bin/bash", import_node_fs4.constants.X_OK);
  } catch {
    throw new SystemOperationError(
      "system_target_unavailable",
      "The native target has no executable /bin/bash."
    );
  }
  return { id, transport: "native", shell: "/bin/bash" };
}
function hasWindowsExecutionTransport(nativeWindows, wslWindows) {
  if (nativeWindows) return true;
  return wslWindows;
}
function hasObservedWindowsPlatform(probe) {
  if (probe.status !== "completed") return false;
  if (probe.exitCode !== 0) return false;
  return probe.stdout.trim() === "Win32NT";
}

// src/computer-access/application-catalog.ts
var CATALOG_ENTRY_LIMIT = 2e3;
function isAbsentOptionalCatalogRoot(error, depth) {
  if (depth !== 0 || !(error instanceof Error)) return false;
  return "code" in error && error.code === "ENOENT";
}
async function readApplicationDirectory(path, depth) {
  try {
    return {
      entries: await (0, import_promises3.readdir)(path, { withFileTypes: true }),
      complete: true
    };
  } catch (error) {
    return { entries: [], complete: isAbsentOptionalCatalogRoot(error, depth) };
  }
}
async function collectApplicationPaths(roots, extension) {
  const pending = roots.map((path) => ({ path, depth: 0 }));
  const paths = [];
  let scannedEntries = 0;
  let complete = true;
  while (pending.length > 0 && scannedEntries < 2e4 && paths.length < CATALOG_ENTRY_LIMIT) {
    const current = pending.shift();
    const directory = await readApplicationDirectory(
      current.path,
      current.depth
    );
    complete = complete && directory.complete;
    for (const entry of directory.entries) {
      scannedEntries += 1;
      if (scannedEntries >= 2e4 || paths.length >= CATALOG_ENTRY_LIMIT) {
        complete = false;
        break;
      }
      const absolute = (0, import_node_path5.join)(current.path, entry.name);
      if (entry.name.endsWith(extension)) {
        paths.push(absolute);
        continue;
      }
      if (!entry.isDirectory()) continue;
      if (current.depth >= 4) {
        complete = false;
        continue;
      }
      pending.push({ path: absolute, depth: current.depth + 1 });
    }
  }
  return {
    paths: [...new Set(paths)].sort(),
    complete: complete && pending.length === 0
  };
}
function parseDesktopApplication(content, path) {
  const section = content.split(/^\[Desktop Entry\]\s*$/mu)[1]?.split(/^\[/mu)[0];
  if (!section) return void 0;
  const fields = new Map(
    section.split(/\r?\n/u).map((line) => {
      const split = line.indexOf("=");
      return [
        line.slice(0, split).trim(),
        line.slice(split + 1).trim()
      ];
    })
  );
  if (fields.get("Type") !== "Application") return void 0;
  if (fields.get("Hidden") === "true") return void 0;
  const name = fields.get("Name");
  if (!name) return void 0;
  return { id: path, name, target: "linux" };
}
async function windowsApplications(target, run) {
  const result = await run({
    executable: target.shell,
    args: powershellArguments(
      "@(Get-StartApps | Sort-Object AppID | Select-Object -First 2001 Name,AppID) | ConvertTo-Json -Compress"
    ),
    timeoutMs: 15e3,
    outputMaxChars: 512e3
  });
  if (result.status !== "completed" || result.exitCode !== 0 || result.outputTruncated)
    throw new SystemOperationError(
      "system_application_catalog_unavailable",
      "Windows Start application catalog could not be read completely within the observation budget."
    );
  let entries;
  try {
    entries = JSON.parse(result.stdout || "[]");
  } catch {
    throw new SystemOperationError(
      "system_application_catalog_invalid",
      "Windows returned an unreadable application catalog."
    );
  }
  const rows = Array.isArray(entries) ? entries : [entries];
  const applications = rows.slice(0, CATALOG_ENTRY_LIMIT).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    if (!("Name" in entry) || !("AppID" in entry)) return [];
    if (typeof entry.Name !== "string" || typeof entry.AppID !== "string")
      return [];
    return [
      { id: entry.AppID, name: entry.Name, target: "windows" }
    ];
  });
  return {
    applications,
    complete: rows.length <= CATALOG_ENTRY_LIMIT,
    scope: {
      source: "windows_start_apps",
      roots: [],
      includesExecutableSearch: false,
      includesOtherTargets: false
    }
  };
}
async function readSystemApplications(target, run) {
  if (target.id === "windows") return windowsApplications(target, run);
  if (target.id === "macos") {
    const roots2 = [
      "/Applications",
      "/System/Applications",
      (0, import_node_path5.join)((0, import_node_os3.homedir)(), "Applications")
    ];
    const catalog2 = await collectApplicationPaths(roots2, ".app");
    return {
      applications: catalog2.paths.map((id) => ({
        id,
        name: (0, import_node_path5.basename)(id, ".app"),
        target: "macos"
      })),
      complete: catalog2.complete,
      scope: {
        source: "macos_application_bundles",
        roots: roots2,
        includesExecutableSearch: false,
        includesOtherTargets: false
      }
    };
  }
  const dataHome = process.env.XDG_DATA_HOME ?? (0, import_node_path5.join)((0, import_node_os3.homedir)(), ".local", "share");
  const dataDirs = (process.env.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share").split(":");
  const roots = [dataHome, ...dataDirs].map(
    (directory) => (0, import_node_path5.join)(directory, "applications")
  );
  const catalog = await collectApplicationPaths(roots, ".desktop");
  const applications = [];
  let complete = catalog.complete;
  for (const path of catalog.paths) {
    let content;
    try {
      content = await (0, import_promises3.readFile)(path, "utf8");
    } catch {
      complete = false;
      continue;
    }
    if (isDesktopEntryOverBudget(content)) {
      complete = false;
      continue;
    }
    const application = parseDesktopApplication(content, path);
    if (application) applications.push(application);
  }
  return {
    applications,
    complete,
    scope: {
      source: "linux_desktop_entries",
      roots,
      includesExecutableSearch: false,
      includesOtherTargets: false
    }
  };
}
function isDesktopEntryOverBudget(content) {
  return content.length > 128e3;
}

// src/computer-access/application-observation.ts
var SUMMARY_MAX_CHARS = 7e3;
var SUMMARY_ROOT_LIMIT = 16;
var SUMMARY_ROOT_CHARS = 256;
function systemApplicationObservation(target, catalog, query, limit) {
  const matches = catalog.applications.filter(
    (application) => matchesApplicationQuery(application.name, application.id, query)
  );
  const data = {
    target: target.id,
    transport: target.transport,
    absenceConclusionSupported: false,
    completenessMeaning: "declared_catalog_sources_only",
    catalogScope: catalog.scope,
    catalogComplete: catalog.complete,
    observedMatches: matches.length,
    omittedMatches: Math.max(0, matches.length - limit),
    applications: matches.slice(0, limit)
  };
  const summaryRoots = catalog.scope.roots.slice(0, SUMMARY_ROOT_LIMIT).map((root) => root.slice(0, SUMMARY_ROOT_CHARS));
  const summary = {
    ...data,
    catalogScope: { ...catalog.scope, roots: summaryRoots },
    summaryRootsOmitted: Math.max(
      0,
      catalog.scope.roots.length - summaryRoots.length
    ),
    summaryRootCharactersOmitted: catalog.scope.roots.reduce(
      (total, root, index) => total + root.length - (summaryRoots[index]?.length ?? 0),
      0
    ),
    applications: [...data.applications],
    summaryApplicationsOmitted: 0
  };
  while (isApplicationSummaryOverBudget(summary)) {
    summary.applications.pop();
    summary.summaryApplicationsOmitted += 1;
  }
  while (isCatalogRootSummaryOverBudget(summary)) {
    const removedRoot = summary.catalogScope.roots.pop();
    summary.summaryRootsOmitted += 1;
    summary.summaryRootCharactersOmitted += removedRoot.length;
  }
  return { output: JSON.stringify(summary), data };
}
function matchesApplicationQuery(name, id, query) {
  if (name.toLowerCase().includes(query)) return true;
  return id.toLowerCase().includes(query);
}
function isApplicationSummaryOverBudget(summary) {
  if (summary.applications.length === 0) return false;
  return JSON.stringify(summary).length > SUMMARY_MAX_CHARS;
}
function isCatalogRootSummaryOverBudget(summary) {
  if (summary.catalogScope.roots.length === 0) return false;
  return JSON.stringify(summary).length > SUMMARY_MAX_CHARS;
}

// src/computer-access/target-observation.ts
async function observeSystemTargets(run = runSystemProcess) {
  const observations = [];
  for (const id of ["linux", "macos", "windows"]) {
    try {
      const target = await resolveSystemTarget(id, run);
      observations.push({
        ...target,
        available: true,
        commandExecutionAvailable: true,
        guiSessionStatus: "not_checked"
      });
    } catch (error) {
      observations.push({
        id,
        available: false,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return {
    host: observeSystemHost(),
    availabilityScope: "command_execution_only",
    targets: observations
  };
}

// src/computer-access/application-launch.ts
function readApplicationArguments(value) {
  if (value === void 0) return [];
  if (!hasBoundedArgumentArray(value))
    throw new SystemOperationError(
      "system_application_arguments_invalid",
      "arguments must be an array of at most 32 strings."
    );
  for (const argument of value) {
    if (!isSupportedApplicationArgument(argument))
      throw new SystemOperationError(
        "system_application_arguments_invalid",
        "Each application argument must be a string without null bytes, at most 4096 characters."
      );
  }
  return [...value];
}
async function launchSystemApplication(input) {
  const { target, params, run } = input;
  const id = readRequiredString(params.application_id, {
    name: "application_id",
    maxLength: 4096
  });
  const args = readApplicationArguments(params.arguments);
  const catalog = await readSystemApplications(target, run);
  const application = catalog.applications.find((entry) => entry.id === id);
  if (!application)
    throw new SystemOperationError(
      "system_application_not_found",
      "The identity is absent from the current target catalog; this does not establish that the application is uninstalled. Inspect the correct OS target and use system_command for bounded executable discovery when this catalog is insufficient."
    );
  const common = {
    timeoutMs: 3e4,
    ...input.abortSignal ? { abortSignal: input.abortSignal } : {}
  };
  if (target.id === "macos")
    return {
      application,
      process: await run({
        ...common,
        executable: "/usr/bin/open",
        args: ["-a", id, ...args.length ? ["--args", ...args] : []]
      })
    };
  if (hasUnsupportedTargetArguments(target, args))
    throw new SystemOperationError(
      "system_application_arguments_unsupported",
      "This target application catalog does not define generic raw arguments. Use system_command with the application's documented native invocation."
    );
  if (target.id === "windows") {
    return {
      application,
      process: await run({
        ...common,
        executable: target.shell,
        args: powershellArguments(
          `$applicationPath=${powershellLiteral("shell:AppsFolder\\" + id)}; Start-Process -FilePath (Join-Path $env:SystemRoot 'explorer.exe') -ArgumentList ('"' + $applicationPath + '"'); Write-Output 'Launch request dispatched to Windows shell.'`
        )
      })
    };
  }
  const launcher = await findExecutable("gio");
  if (!launcher)
    throw new SystemOperationError(
      "system_application_launcher_unavailable",
      "The installed desktop application catalog was read, but a native gio launcher is unavailable."
    );
  return {
    application,
    process: await run({
      ...common,
      executable: launcher,
      args: ["launch", id]
    })
  };
}
function hasBoundedArgumentArray(value) {
  if (!Array.isArray(value)) return false;
  return value.length <= 32;
}
function isSupportedApplicationArgument(value) {
  if (typeof value !== "string") return false;
  if (value.length > 4096) return false;
  return !value.includes("\0");
}
function hasUnsupportedTargetArguments(target, args) {
  if (target.id === "macos") return false;
  return args.length > 0;
}

// src/computer-access/commands.ts
var import_promises4 = require("node:fs/promises");
var import_node_path6 = require("node:path");

// src/computer-access/elevation.ts
var WINDOWS_ADMIN_PROBE = "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)";
async function elevatedSystemCommand(input) {
  const { target, command, cwd, run } = input;
  if (target.id === "windows")
    return windowsElevatedCommand(target, command, cwd, run);
  if (process.getuid?.() === 0)
    return { executable: target.shell, args: ["-lc", command], cwd };
  if (target.id === "macos") {
    const script = `cd ${shellLiteral(cwd)} && ${shellLiteral(target.shell)} -lc ${shellLiteral(command)}`;
    const appleScriptString = JSON.stringify(script);
    return {
      executable: "/usr/bin/osascript",
      args: [
        "-e",
        `do shell script ${appleScriptString} with administrator privileges`
      ]
    };
  }
  const probe = await run({
    executable: "/usr/bin/sudo",
    args: ["-n", "--", "/usr/bin/true"],
    timeoutMs: 5e3
  });
  if (!hasSuccessfulPrivilegeProbe(probe))
    throw new SystemOperationError(
      "system_authorization_required",
      "Linux sudo authorization requires a human or a configured native privilege policy. Authenticate in a native terminal or supply an authorized host; ABot does not request, invent or bypass passwords."
    );
  return {
    executable: "/usr/bin/sudo",
    args: ["-n", "--", target.shell, "-lc", command],
    cwd
  };
}
function hasSuccessfulPrivilegeProbe(probe) {
  if (probe.status !== "completed") return false;
  return probe.exitCode === 0;
}
function hasWindowsAdministratorAuthority(probe) {
  if (!hasSuccessfulPrivilegeProbe(probe)) return false;
  return probe.stdout.trim() === "True";
}
async function windowsElevatedCommand(target, command, cwd, run) {
  const probe = await run({
    executable: target.shell,
    args: powershellArguments(WINDOWS_ADMIN_PROBE),
    timeoutMs: 5e3
  });
  if (!hasWindowsAdministratorAuthority(probe))
    throw new SystemOperationError(
      "system_authorization_required",
      "Windows Administrator authority is required. Approve UAC in a native Windows elevated host, then retry; this noninteractive transport cannot answer UAC or provide credentials."
    );
  return {
    executable: target.shell,
    args: powershellArguments(windowsSystemCommandScript(command, cwd))
  };
}

// src/computer-access/commands.ts
async function executeSystemCommand(input) {
  const { target, params, run } = input;
  const command = readRequiredString(params.command, {
    name: "command",
    trim: false,
    maxLength: 4096
  });
  const cwd = readRequiredString(params.cwd, { name: "cwd", maxLength: 4096 });
  const timeoutMs = params.timeout_ms === void 0 ? 6e4 : readBoundedInteger(params.timeout_ms, {
    name: "timeout_ms",
    minimum: 1e3,
    maximum: 6e5
  });
  if (hasSystemCommandNullBytes(command, cwd))
    throw new SystemOperationError(
      "system_command_invalid",
      "Commands and directories cannot contain null bytes."
    );
  if (hasInvalidElevationFlag(params.elevated))
    throw new SystemOperationError(
      "system_command_invalid",
      "elevated must be a boolean."
    );
  const absoluteCwd = target.id === "windows" ? hasExplicitWindowsDirectory(cwd) : (0, import_node_path6.isAbsolute)(cwd);
  if (!absoluteCwd)
    throw new SystemOperationError(
      "system_cwd_invalid",
      "System commands require an explicit absolute directory in the selected OS namespace."
    );
  await requireNativeWorkingDirectory(target, cwd);
  const plan = params.elevated === true ? await elevatedSystemCommand({ target, command, cwd, run }) : unprivilegedSystemCommand(target, command, cwd);
  return run({
    ...plan,
    timeoutMs,
    ...input.abortSignal ? { abortSignal: input.abortSignal } : {}
  });
}
function unprivilegedSystemCommand(target, command, cwd) {
  if (target.id === "windows")
    return {
      executable: target.shell,
      args: powershellArguments(windowsSystemCommandScript(command, cwd))
    };
  return { executable: target.shell, args: ["-lc", command], cwd };
}
function hasExplicitWindowsDirectory(path) {
  if (/^[a-z]:[\\/]/iu.test(path)) return true;
  return /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/u.test(path);
}
function hasSystemCommandNullBytes(command, cwd) {
  if (command.includes("\0")) return true;
  return cwd.includes("\0");
}
function hasInvalidElevationFlag(value) {
  if (value === void 0) return false;
  return typeof value !== "boolean";
}
async function requireNativeWorkingDirectory(target, cwd) {
  if (target.id === "windows") return;
  const directory = await (0, import_promises4.stat)(cwd).catch(() => void 0);
  if (directory?.isDirectory()) return;
  throw new SystemOperationError(
    "system_cwd_unavailable",
    "The selected target directory is unavailable or not a directory."
  );
}

// src/computer-access/process-result.ts
var STREAM_EXCERPT_CHARS = 2e3;
var IDENTITY_EXCERPT_CHARS = 512;
var LEGACY_EVIDENCE_LABELS = {
  command_process_completion: "system command process completion",
  launch_request_dispatch: "application launch request dispatch"
};
function systemProcessResult(target, result, evidenceScope, application) {
  const stdoutOmittedChars = Math.max(
    0,
    result.stdout.length - STREAM_EXCERPT_CHARS
  );
  const stderrOmittedChars = Math.max(
    0,
    result.stderr.length - STREAM_EXCERPT_CHARS
  );
  const data = {
    evidenceScope,
    evidence: LEGACY_EVIDENCE_LABELS[evidenceScope],
    independentOutcomeCheck: "not_performed",
    target: target.id,
    transport: target.transport,
    processStatus: result.status,
    spawnedProcess: result.spawnedProcess ?? null,
    ...application ? { catalogApplication: application } : {},
    outputTruncated: result.outputTruncated,
    summaryOmittedChars: {
      stdout: stdoutOmittedChars,
      stderr: stderrOmittedChars
    },
    observationMeta: {
      kind: "volatile_external",
      carryPolicy: "never"
    }
  };
  const output = [
    `Adapter evidence: ${evidenceScope}. Independent outcome check: not performed. Completion/dispatch alone does not verify the requested application, window or system effect; evaluate command evidence separately.`,
    `Target: ${target.id} (${target.transport})`,
    `Process status: ${result.status}; exit code: ${result.exitCode ?? "unavailable"}`,
    result.spawnedProcess ? `Spawned helper: ${identityExcerpt(result.spawnedProcess.executable)}; PID ${result.spawnedProcess.pid} in runtime OS namespace. Identity comes from spawn arguments, not application image inspection.` : "Spawned helper identity: not recorded.",
    ...application ? [
      `Revalidated catalog identity: ${identityExcerpt(application.id)} (identity only; no application process/window check).`
    ] : [],
    "STDOUT excerpt:",
    result.stdout.slice(0, STREAM_EXCERPT_CHARS) || "(empty)",
    "STDERR excerpt:",
    result.stderr.slice(0, STREAM_EXCERPT_CHARS) || "(empty)",
    `Summary omitted characters: stdout=${stdoutOmittedChars}, stderr=${stderrOmittedChars}. Raw stream capture truncated: ${result.outputTruncated}.`
  ].join("\n");
  if (hasSuccessfulSystemObservation(result)) {
    return successResult({
      output,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: 0,
      data
    });
  }
  const errorCode = result.status === "completed" ? "system_command_failed" : `system_${result.status}`;
  return failureResult({
    errorCode,
    message: hasUncertainDescendantState(result) ? "System command observation stopped. External or detached descendants may remain; inspect the target before retrying." : "The target did not report successful command completion.",
    output,
    stdout: result.stdout,
    stderr: result.stderr,
    ...result.exitCode !== null ? { exitCode: result.exitCode } : {},
    data
  });
}
function hasSuccessfulSystemObservation(result) {
  if (result.status !== "completed") return false;
  return result.exitCode === 0;
}
function hasUncertainDescendantState(result) {
  if (result.status === "timeout") return true;
  return result.status === "aborted";
}
function identityExcerpt(identity) {
  if (identity.length <= IDENTITY_EXCERPT_CHARS) return identity;
  return `${identity.slice(0, IDENTITY_EXCERPT_CHARS)} [${identity.length - IDENTITY_EXCERPT_CHARS} characters omitted; full identity in result data]`;
}

// src/computer-access/handlers.ts
function withSystemOperationErrors(operation) {
  return async (params, context) => {
    try {
      return await operation(params, context);
    } catch (error) {
      if (error instanceof SystemOperationError)
        return failureResult({
          errorCode: error.code,
          message: error.message,
          data: {
            humanActionRequired: error.code === "system_authorization_required"
          }
        });
      return failureFromError(error, {
        fallbackCode: "system_operation_failed",
        fallbackMessage: "The native system operation failed.",
        operation: "system"
      });
    }
  };
}
function createSystemHandlers(run = runSystemProcess, resolveTarget = (id) => resolveSystemTarget(id, run)) {
  const targets = async () => {
    const observation = await observeSystemTargets(run);
    return successResult({
      output: JSON.stringify(observation),
      data: {
        ...observation,
        observationMeta: { kind: "volatile_external", carryPolicy: "never" }
      }
    });
  };
  const command = async (params, context) => {
    const target = await resolveTarget(readSystemTargetId(params.target));
    const result = await executeSystemCommand({
      target,
      params,
      run,
      ...context?.abortSignal ? { abortSignal: context.abortSignal } : {}
    });
    return systemProcessResult(target, result, "command_process_completion");
  };
  const applications = async (params) => {
    const target = await resolveTarget(readSystemTargetId(params.target));
    const query = (readOptionalString(params.query) ?? "").toLowerCase();
    const limit = params.limit === void 0 ? 50 : readBoundedInteger(params.limit, {
      name: "limit",
      minimum: 1,
      maximum: 100
    });
    const catalog = await readSystemApplications(target, run);
    const { output, data } = systemApplicationObservation(
      target,
      catalog,
      query,
      limit
    );
    return successResult({
      output,
      data: {
        ...data,
        observationMeta: { kind: "volatile_external", carryPolicy: "never" }
      }
    });
  };
  const launch = async (params, context) => {
    const target = await resolveTarget(readSystemTargetId(params.target));
    const result = await launchSystemApplication({
      target,
      params,
      run,
      ...context?.abortSignal ? { abortSignal: context.abortSignal } : {}
    });
    return systemProcessResult(
      target,
      result.process,
      "launch_request_dispatch",
      result.application
    );
  };
  return {
    system_targets: withSystemOperationErrors(targets),
    system_command: withSystemOperationErrors(command),
    system_applications: withSystemOperationErrors(applications),
    system_launch: withSystemOperationErrors(launch)
  };
}

// plugins/system/source/computer/public-action.ts
function readPublicComputerAction(params) {
  const fields = ["desktop_ref", "observation_ref", "action_kind"];
  const kind = params.action_kind;
  switch (kind) {
    case "click":
      computerFields(params, [...fields, "x", "y", "button", "count"]);
      return {
        kind,
        point: { x: params.x, y: params.y },
        button: params.button,
        count: params.count
      };
    case "move":
      computerFields(params, [...fields, "x", "y"]);
      return { kind, point: { x: params.x, y: params.y } };
    case "drag":
      computerFields(params, [
        ...fields,
        "from_x",
        "from_y",
        "to_x",
        "to_y",
        "button",
        "duration_ms"
      ]);
      return {
        kind,
        from: { x: params.from_x, y: params.from_y },
        to: { x: params.to_x, y: params.to_y },
        button: params.button,
        durationMs: params.duration_ms
      };
    case "scroll":
      computerFields(params, [...fields, "delta_x", "delta_y"]);
      return { kind, deltaX: params.delta_x, deltaY: params.delta_y };
    case "type_text":
      computerFields(params, [...fields, "text"]);
      return { kind, text: params.text };
    case "press_keys":
      computerFields(params, [...fields, "keys"]);
      return { kind, keys: params.keys };
    case "focus_window":
      computerFields(params, [...fields, "window_ref"]);
      return { kind, window_ref: params.window_ref };
    default:
      return computerInputError("Select a declared computer action operation.");
  }
}

// plugins/system/source/computer/observation-output.ts
var COMPUTER_OBSERVATION_OUTPUT_MAX_BYTES = 48 * 1024;
var ARRAY_FIELDS = ["accessibility", "windows"];
var ESSENTIAL_FIELDS = [
  "desktop_ref",
  "observation_ref",
  "platform",
  "displayTarget",
  "transport",
  "capturedAt",
  "imageWidth",
  "imageHeight",
  "coordinateSpace",
  "targetingGuarantee",
  "available",
  "imageAvailable",
  "evidenceScope",
  "requestedEffectVerified",
  "observationMeta"
];
function serializeComputerObservation(description, data) {
  const observation = { ...description, ...data };
  return boundedOutput([observation], (items) => items[0]);
}
function serializeComputerDesktops(desktops) {
  return boundedOutput(desktops, (items) => ({ desktops: items }));
}
function boundedOutput(observations, envelope) {
  const projected = observations.map((observation) => ({ ...observation }));
  const serialize = () => JSON.stringify(envelope(projected));
  let output = serialize();
  if (fits(output)) return output;
  const collections = projected.flatMap(
    (observation) => ARRAY_FIELDS.flatMap(
      (field) => Array.isArray(observation[field]) ? [
        {
          observation,
          field,
          original: observation[field]
        }
      ] : []
    )
  );
  for (const collection of collections) {
    setRetainedCount(collection, 0);
    output = serialize();
    if (!fits(output)) continue;
    let low = 0;
    let high = collection.original.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      setRetainedCount(collection, middle);
      if (fits(serialize())) low = middle;
      else high = middle - 1;
    }
    setRetainedCount(collection, low);
    return serialize();
  }
  const minimal = projected.map(minimalObservation);
  output = JSON.stringify(envelope(minimal));
  if (fits(output)) return output;
  throw new Error("computer_observation_identity_exceeds_output_budget");
}
function setRetainedCount(collection, count) {
  const { observation, field, original } = collection;
  observation[field] = original.slice(0, count);
  const omittedCount = original.length - count;
  if (omittedCount === 0) return;
  const coverage = record(observation.outputCoverage) ?? {};
  observation.outputCoverage = {
    ...coverage,
    kind: "computer_output_coverage_v1",
    reason: "output_byte_limit",
    [field]: { retainedCount: count, omittedCount }
  };
  observation[`${field}Truncated`] = true;
}
function minimalObservation(observation) {
  const output = {};
  for (const field of ESSENTIAL_FIELDS) {
    if (observation[field] !== void 0) output[field] = observation[field];
  }
  const dispatch = record(observation.dispatch);
  if (dispatch) {
    output.dispatch = {
      status: dispatch.status,
      requestedInputCount: dispatch.requestedInputCount,
      ...dispatch.acceptedInputCount === void 0 ? {} : { acceptedInputCount: dispatch.acceptedInputCount }
    };
  }
  for (const field of ARRAY_FIELDS) {
    if (Array.isArray(observation[field])) output[field] = [];
    if (observation[`${field}Truncated`] !== void 0)
      output[`${field}Truncated`] = observation[`${field}Truncated`];
  }
  output.outputCoverage = observation.outputCoverage;
  output.outputError = {
    code: "computer_observation_metadata_too_large",
    message: "Descriptive metadata exceeds the output limit. Identity, image geometry, and input dispatch counts are retained; other metadata is omitted."
  };
  return output;
}
function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return void 0;
  return value;
}
function fits(value) {
  return Buffer.byteLength(value, "utf8") <= COMPUTER_OBSERVATION_OUTPUT_MAX_BYTES;
}

// plugins/system/source/computer/request-computers.ts
var import_node_crypto7 = require("node:crypto");

// plugins/system/source/request-target-snapshot.ts
async function captureSystemTargetSnapshot(input) {
  const [native, companion] = await Promise.allSettled([
    input.observeTargets(),
    input.readHostStatus()
  ]);
  const routes = capturedNativeRoutes(native);
  if (companion.status !== "fulfilled") return Object.freeze(routes);
  const remote = connectedCompanionRoute(companion.value);
  if (!remote) return Object.freeze(routes);
  if (!input.includeSameOsCompanion && routes.some((route) => routeTargetId(route) === remote.target))
    return Object.freeze(routes);
  return Object.freeze([...routes, remote]);
}
function capturedNativeRoutes(observation) {
  if (observation.status !== "fulfilled") return [];
  return observation.value.targets.flatMap((target) => {
    if (!target.available) return [];
    return [
      Object.freeze({
        kind: "native",
        target: Object.freeze({
          id: target.id,
          shell: target.shell,
          transport: target.transport
        })
      })
    ];
  });
}
function connectedCompanionRoute(status) {
  if (!status.paired) return void 0;
  if (!status.connected) return void 0;
  if (!isHostIdentifier(status.hostId)) return void 0;
  if (!isHostIdentifier(status.connectionId)) return void 0;
  if (!isHostIdentity(status.identity)) return void 0;
  return Object.freeze({
    kind: "companion",
    target: status.identity.os,
    hostId: status.hostId,
    connectionId: status.connectionId,
    identity: Object.freeze({ ...status.identity }),
    ...status.capabilities ? { capabilities: Object.freeze([...status.capabilities]) } : {}
  });
}
function routeTargetId(route) {
  if (route.kind === "native") return route.target.id;
  return route.target;
}
function requireSystemRequestRoute(snapshot, target) {
  const route = snapshot.find(
    (candidate) => routeTargetId(candidate) === target
  );
  if (route) return route;
  throw new SystemOperationError(
    "system_target_unavailable",
    "The requested OS target is unavailable in this request."
  );
}
function resolveCapturedNativeTarget(snapshot, target) {
  const route = requireSystemRequestRoute(snapshot, target);
  if (route.kind === "native") return route.target;
  throw new SystemOperationError(
    "system_target_unavailable",
    "The request did not bind this target to native execution."
  );
}
function systemRouteBindingIdentity(route) {
  if (route.kind === "native")
    return JSON.stringify([route.kind, route.target]);
  return JSON.stringify([
    route.kind,
    route.target,
    route.hostId,
    route.connectionId
  ]);
}
function systemRouteMetadata(route) {
  if (route.kind === "native")
    return {
      displayTarget: route.target.id,
      transport: route.target.transport
    };
  return {
    displayTarget: route.target,
    transport: "host_companion",
    computerName: route.identity.name
  };
}
function observeCapturedSystemTargets(snapshot) {
  return {
    targets: snapshot.map((route) => ({
      id: routeTargetId(route),
      available: true,
      ...modelSafeRouteObservation(route),
      guiSessionStatus: "not_checked"
    })),
    availabilityScope: "request_execution_routes"
  };
}
function modelSafeRouteObservation(route) {
  if (route.kind === "native")
    return {
      transport: route.target.transport,
      commandExecutionStatus: "probed",
      availabilityScope: "command_execution_only"
    };
  return {
    transport: "host_companion",
    commandExecutionStatus: "not_probed",
    availabilityScope: "transport_connection_only"
  };
}

// plugins/system/source/computer/desktop-bindings.ts
var import_node_crypto6 = require("node:crypto");
var DesktopBindings = class {
  current;
  windows = /* @__PURE__ */ new Map();
  observe(result) {
    this.windows.clear();
    const windows = result.windows.map((window) => {
      const id2 = (0, import_node_crypto6.randomUUID)();
      this.windows.set(id2, window.binding);
      const { binding: _binding, ...details } = window;
      return {
        window_ref: id2,
        ...details,
        bounds: result.observation ? imageRectangle(window.bounds, result.observation) : window.bounds
      };
    });
    this.current = void 0;
    if (!result.observation)
      return {
        windows,
        observation_ref: void 0,
        coordinateSpace: result.desktop.coordinateSpace ?? "native_desktop"
      };
    const id = (0, import_node_crypto6.randomUUID)();
    this.current = {
      id,
      issuedAt: Date.now(),
      result,
      observation: result.observation
    };
    const {
      region: _region,
      accessibility,
      ...observation
    } = result.observation;
    return {
      windows,
      observation_ref: id,
      ...observation,
      coordinateSpace: "image_pixels",
      accessibility: accessibility.map((node) => ({
        ...node,
        ...node.bounds ? { bounds: imageRectangle(node.bounds, result.observation) } : {}
      }))
    };
  }
  action(observationRef, value) {
    const current = this.current;
    if (!current || current.id !== observationRef)
      throw new SystemOperationError(
        "computer_observation_stale",
        "Observe this desktop again; the observation reference is not current for this request."
      );
    if (Date.now() - current.issuedAt > 12e4)
      throw new SystemOperationError(
        "computer_observation_expired",
        "The observation is more than two minutes old. Observe again before input."
      );
    const action = this.resolveAction(value);
    const translated = translateAction(action, current.observation);
    this.current = void 0;
    return {
      operation: "act",
      desktopBinding: current.result.desktop.binding,
      expectedGeometry: current.result.desktop.bounds,
      ...current.result.focusedWindow ? { expectedWindow: current.result.focusedWindow } : {},
      action: translated,
      deadlineEpochMs: Date.now() + 15e3
    };
  }
  snapshot() {
    const current = this.current;
    const result = current ? (({ image: _image, ...value }) => value)(current.result) : void 0;
    return {
      kind: "desktop_bindings_v1",
      windows: [...this.windows],
      ...current ? { current: { id: current.id, issuedAt: current.issuedAt, result } } : {}
    };
  }
  restore(value) {
    const saved = computerRecord(value);
    computerFields(saved, ["kind", "windows", "current"]);
    if (saved.kind !== "desktop_bindings_v1" || !Array.isArray(saved.windows) || saved.windows.length > 256)
      throw new Error("desktop_bindings_snapshot_invalid");
    const windows = /* @__PURE__ */ new Map();
    for (const item of saved.windows) {
      if (!Array.isArray(item) || item.length !== 2)
        throw new Error("desktop_bindings_snapshot_invalid");
      const ref = computerText(item[0], 128), binding = computerText(item[1]);
      if (windows.has(ref))
        throw new Error("desktop_bindings_snapshot_invalid");
      windows.set(ref, binding);
    }
    let current;
    if (saved.current !== void 0) {
      const entry = computerRecord(saved.current);
      computerFields(entry, ["id", "issuedAt", "result"]);
      const id = computerText(entry.id, 128);
      if (typeof entry.issuedAt !== "number" || !Number.isFinite(entry.issuedAt) || entry.issuedAt < 0)
        throw new Error("desktop_bindings_snapshot_invalid");
      const result = readNativeComputerResult(entry.result);
      if (!result.observation)
        throw new Error("desktop_bindings_snapshot_invalid");
      current = {
        id,
        issuedAt: entry.issuedAt,
        result,
        observation: result.observation
      };
    }
    this.clear();
    this.current = current;
    for (const [ref, binding] of windows) this.windows.set(ref, binding);
  }
  clear() {
    this.current = void 0;
    this.windows.clear();
  }
  regionalObservation(observationRef, rectangle) {
    const current = this.current;
    if (!current || current.id !== observationRef)
      throw new SystemOperationError(
        "computer_observation_stale",
        "Use a current observation to select a smaller region."
      );
    const observation = current.observation;
    if (!isRegionInsideImage(rectangle, observation))
      throw new SystemOperationError(
        "computer_region_outside_image",
        "Select a region inside the returned image."
      );
    const scaleX = observation.region.width / observation.imageWidth;
    const scaleY = observation.region.height / observation.imageHeight;
    return {
      operation: "observe",
      desktopBinding: current.result.desktop.binding,
      expectedGeometry: current.result.desktop.bounds,
      region: {
        x: Math.round(observation.region.x + rectangle.x * scaleX),
        y: Math.round(observation.region.y + rectangle.y * scaleY),
        width: Math.max(1, Math.floor(rectangle.width * scaleX)),
        height: Math.max(1, Math.floor(rectangle.height * scaleY))
      }
    };
  }
  resolveAction(value) {
    const action = computerRecord(value);
    if (action.kind !== "focus_window") return readNativeComputerAction(action);
    const ref = computerText(action.window_ref, 128);
    if (Object.keys(action).some((key) => !["kind", "window_ref"].includes(key)))
      throw new SystemOperationError(
        "computer_input_invalid",
        "Unexpected focus fields."
      );
    const binding = this.windows.get(ref);
    if (!binding)
      throw new SystemOperationError(
        "computer_window_stale",
        "Select a window returned by this observation."
      );
    return { kind: "focus_window", windowBinding: binding };
  }
};
function imageRectangle(bounds, observation) {
  const scaleX = observation.imageWidth / observation.region.width;
  const scaleY = observation.imageHeight / observation.region.height;
  return {
    x: (bounds.x - observation.region.x) * scaleX,
    y: (bounds.y - observation.region.y) * scaleY,
    width: bounds.width * scaleX,
    height: bounds.height * scaleY
  };
}
function isRegionInsideImage(rectangle, observation) {
  if (rectangle.x < 0 || rectangle.y < 0) return false;
  if (rectangle.x + rectangle.width > observation.imageWidth) return false;
  return rectangle.y + rectangle.height <= observation.imageHeight;
}
function translateAction(action, observation) {
  const point = (value) => {
    if (value.x < 0 || value.x >= observation.imageWidth || value.y < 0 || value.y >= observation.imageHeight)
      throw new SystemOperationError(
        "computer_coordinate_outside_image",
        "Use coordinates inside the returned image."
      );
    return {
      x: Math.round(
        observation.region.x + value.x * observation.region.width / observation.imageWidth
      ),
      y: Math.round(
        observation.region.y + value.y * observation.region.height / observation.imageHeight
      )
    };
  };
  if (action.kind === "click" || action.kind === "move")
    return { ...action, point: point(action.point) };
  if (action.kind === "drag")
    return { ...action, from: point(action.from), to: point(action.to) };
  return action;
}

// plugins/system/source/computer/request-computers.ts
var RequestComputers = class {
  constructor(rootDir, routes, connection, nativeFactory = createNativeComputerBackend, snapshot) {
    this.rootDir = rootDir;
    this.connection = connection;
    this.nativeFactory = nativeFactory;
    this.entries = snapshot === void 0 ? routes.map((route) => ({
      ref: (0, import_node_crypto7.randomUUID)(),
      route,
      bindings: new DesktopBindings()
    })) : restoreComputers(routes, snapshot);
  }
  rootDir;
  connection;
  nativeFactory;
  entries;
  closed = false;
  snapshot() {
    if (this.closed) throw new Error("computer_request_closed");
    return {
      kind: "request_computers_v1",
      entries: this.entries.map((entry) => ({
        ref: entry.ref,
        routeIdentity: systemRouteBindingIdentity(entry.route),
        bindings: entry.bindings.snapshot()
      }))
    };
  }
  require(ref) {
    if (this.closed)
      throw new SystemOperationError(
        "computer_request_closed",
        "This request's desktop bindings have expired."
      );
    const entry = this.entries.find((candidate) => candidate.ref === ref);
    if (!entry)
      throw new SystemOperationError(
        "computer_desktop_unavailable",
        "Select a desktop reference offered in this request."
      );
    return entry;
  }
  backend(entry) {
    if (this.closed)
      throw new SystemOperationError(
        "computer_request_closed",
        "The computer request has closed."
      );
    if (!supportsComputerRoute(entry.route))
      throw new SystemOperationError(
        "computer_companion_upgrade_required",
        "Install the companion from this Runtime build to enable desktop observation and input."
      );
    if (entry.backend) return entry.backend;
    entry.backend = entry.route.kind === "native" ? this.nativeFactory(entry.route.target) : createCompanionComputerBackend(
      this.rootDir,
      entry.route,
      this.connection
    );
    return entry.backend;
  }
  async close() {
    this.closed = true;
    for (const entry of this.entries) entry.bindings.clear();
    await Promise.allSettled(
      this.entries.map((entry) => entry.backend?.close())
    );
  }
};
function computerRouteLabel(entry) {
  return {
    desktop_ref: entry.ref,
    platform: routeTargetId(entry.route),
    ...systemRouteMetadata(entry.route)
  };
}
function computerQueueIdentity(entry) {
  return `computer-local-platform:${routeTargetId(entry.route)}`;
}
function supportsComputerRoute(route) {
  if (route.kind === "native") return true;
  return route.capabilities?.includes(COMPUTER_CAPABILITY) === true;
}
function restoreComputers(routes, value) {
  if (!value || typeof value !== "object" || !("kind" in value) || value.kind !== "request_computers_v1" || !("entries" in value) || !Array.isArray(value.entries))
    throw new Error("request_computers_snapshot_invalid");
  const refs = /* @__PURE__ */ new Set(), identities = /* @__PURE__ */ new Set();
  return value.entries.flatMap((entry) => {
    if (!entry || typeof entry.ref !== "string" || !entry.ref || typeof entry.routeIdentity !== "string" || refs.has(entry.ref) || identities.has(entry.routeIdentity))
      throw new Error("request_computers_snapshot_invalid");
    refs.add(entry.ref);
    identities.add(entry.routeIdentity);
    const bindings = new DesktopBindings();
    bindings.restore(entry.bindings);
    const route = routes.find(
      (route2) => systemRouteBindingIdentity(route2) === entry.routeIdentity
    );
    const hasSavedRoute = route !== void 0;
    if (!hasSavedRoute) return [];
    return [{ ref: entry.ref, route, bindings }];
  });
}

// plugins/system/source/computer/observation-result.ts
function describeDesktop(entry, result) {
  const {
    binding: _binding,
    bounds: _bounds,
    coordinateSpace: _coordinateSpace,
    ...desktop
  } = result.desktop;
  return {
    ...computerRouteLabel(entry),
    ...desktop,
    ...entry.bindings.observe(result)
  };
}
async function projectComputerResult(entry, result, context) {
  const media = [];
  let imageFailure;
  if (result.image) {
    try {
      const image = await context.media.writeImage(result.image);
      if (!hasMatchingImageGeometry(image, result))
        throw new SystemOperationError(
          "computer_image_geometry_mismatch",
          "Native observation dimensions do not match the captured image. Observe again before input."
        );
      media.push(image);
    } catch (error) {
      imageFailure = error instanceof Error ? error.message : "Image admission failed.";
    } finally {
      result.image.bytes.fill(0);
    }
  }
  const description = describeDesktop(entry, result);
  if (media.length === 0) {
    entry.bindings.clear();
    description.observation_ref = void 0;
  }
  const hasPartialInputDispatch = result.dispatch?.status === "partial";
  const operationError = result.error ?? (hasPartialInputDispatch ? { code: "computer_input_partial", message: "Only part of the input was accepted." } : void 0);
  const data = {
    desktop_ref: entry.ref,
    ...description.observation_ref ? { observation_ref: description.observation_ref } : {},
    ...result.dispatch ? { dispatch: result.dispatch } : {},
    ...inputDispatchEvidence(entry.ref, result.dispatch),
    currentStateEvidence: Boolean(result.observation),
    ...operationError ? { error: operationError } : {},
    ...imageFailure ? { imageError: imageFailure } : {},
    imageAvailable: media.length > 0,
    evidenceScope: "observed_desktop_and_input_receipt",
    requestedEffectVerified: false,
    observationMeta: {
      kind: "volatile_external",
      carryPolicy: "never"
    }
  };
  const output = serializeComputerObservation(description, data);
  if (imageFailure || operationError)
    return failureResult({
      errorCode: operationError?.code ?? "computer_image_unavailable",
      message: operationError?.message ?? imageFailure,
      output,
      data,
      media
    });
  return successResult({ output, data, media });
}
function inputDispatchEvidence(desktopRef, dispatch) {
  if (!dispatch || !["accepted", "partial"].includes(dispatch.status))
    return {};
  const accepted = dispatch.acceptedInputCount;
  if (!Number.isSafeInteger(accepted) || !accepted || accepted < 0) return {};
  if (!Number.isSafeInteger(dispatch.requestedInputCount)) return {};
  if (accepted > dispatch.requestedInputCount) return {};
  return {
    mutationEvidence: true,
    mutationGrounding: JSON.stringify({
      kind: "computer_input_receipt_v1",
      desktop_ref: desktopRef,
      dispatch,
      evidenceScope: "native_input_dispatch_only",
      requestedEffectVerified: false
    })
  };
}
function hasMatchingImageGeometry(image, result) {
  if (!result.observation) return false;
  if (image.width !== result.observation.imageWidth) return false;
  return image.height === result.observation.imageHeight;
}

// plugins/system/source/computer/handlers.ts
var COMPUTER_TOOLS = [
  "computer_desktops",
  "computer_observe",
  "computer_act"
];
function isComputerTool(name) {
  return COMPUTER_TOOLS.some((tool) => tool === name);
}
function createComputerHandlers(computers) {
  let registered = false;
  const guard = (handler) => async (params, context) => {
    try {
      if (!context?.onRequestDispose)
        throw new SystemOperationError(
          "computer_lifecycle_unavailable",
          "Computer control requires request resource cleanup support."
        );
      if (!registered) {
        context.onRequestDispose(() => computers.close());
        registered = true;
      }
      context.abortSignal?.throwIfAborted();
      return await handler(params, context);
    } catch (error) {
      return failureResult({
        errorCode: error instanceof SystemOperationError ? error.code : "computer_operation_interrupted",
        message: error instanceof Error ? error.message : "Computer operation interrupted; effects may be partial. Observe before another action."
      });
    }
  };
  return {
    computer_desktops: guard(async (params, context) => {
      computerFields(params, []);
      const desktops = [];
      for (const entry of computers.entries) {
        const observation = await withDesktopQueue(
          computerQueueIdentity(entry),
          context?.abortSignal,
          async () => {
            try {
              entry.bindings.clear();
              const result = await computers.backend(entry).execute({ operation: "inspect" }, context?.abortSignal);
              return describeDesktop(entry, result);
            } catch (error) {
              return {
                ...computerRouteLabel(entry),
                available: false,
                reason: error instanceof Error ? error.message : "Desktop inspection failed."
              };
            }
          }
        );
        desktops.push(observation);
      }
      return successResult({
        output: serializeComputerDesktops(desktops),
        data: {
          desktopCount: desktops.length,
          observationMeta: { kind: "volatile_external", carryPolicy: "never" }
        }
      });
    }),
    computer_observe: guard(async (params, context) => {
      computerFields(params, [
        "desktop_ref",
        "observation_ref",
        "x",
        "y",
        "width",
        "height"
      ]);
      const entry = computers.require(params.desktop_ref);
      requireMedia(context);
      return withDesktopQueue(
        computerQueueIdentity(entry),
        context?.abortSignal,
        async () => {
          const request = params.observation_ref === void 0 ? { operation: "observe" } : entry.bindings.regionalObservation(
            params.observation_ref,
            readPhysicalRectangle({
              x: params.x,
              y: params.y,
              width: params.width,
              height: params.height
            })
          );
          entry.bindings.clear();
          const result = await computers.backend(entry).execute(request, context?.abortSignal);
          return projectComputerResult(entry, result, context);
        }
      );
    }),
    computer_act: guard(async (params, context) => {
      const action = readPublicComputerAction(params);
      const entry = computers.require(params.desktop_ref);
      requireMedia(context);
      return withDesktopQueue(
        computerQueueIdentity(entry),
        context?.abortSignal,
        async () => {
          const request = entry.bindings.action(params.observation_ref, action);
          const result = await computers.backend(entry).execute(request, context?.abortSignal);
          return projectComputerResult(entry, result, context);
        }
      );
    })
  };
}
function requireMedia(context) {
  if (!context?.media)
    throw new SystemOperationError(
      "computer_media_unavailable",
      "The runtime does not support temporary tool images."
    );
}

// plugins/system/source/computer/request-modules.ts
function unboundComputerHandlers() {
  return Object.fromEntries(
    COMPUTER_TOOLS.map((name) => [
      name,
      async () => failureResult({
        errorCode: "computer_request_binding_required",
        message: "Computer control requires a prepared request."
      })
    ])
  );
}
function prepareComputerModules(rootDir, modules, routes, connection, preparation) {
  if (modules.length === 0) return [];
  const computers = new RequestComputers(
    rootDir,
    routes,
    connection,
    void 0,
    preparation?.requestState?.read("system.computers.v1")
  );
  preparation?.requestState?.register("system.computers.v1", {
    snapshot: () => computers.snapshot(),
    dispose: () => computers.close()
  });
  if (computers.entries.length === 0) return [];
  const handlers = createComputerHandlers(computers);
  const refs = computers.entries.map((entry) => entry.ref);
  return modules.map((module2) => ({
    ...module2,
    implementation: handlers[module2.definition.name],
    normalInvocation: {
      ...module2.normalInvocation,
      operations: module2.normalInvocation.operations.map((operation) => ({
        ...operation,
        input: {
          ...operation.input,
          properties: {
            ...operation.input.properties,
            ...Object.hasOwn(operation.input.properties, "desktop_ref") ? { desktop_ref: { type: "string", enum: refs } } : {}
          }
        }
      }))
    },
    adapter: {
      ...module2.adapter,
      executionBinding: (call) => {
        if (call.tool === "computer_desktops")
          return {
            identity: JSON.stringify(
              computers.entries.map(
                (entry2) => systemRouteBindingIdentity(entry2.route)
              )
            ),
            metadata: { displayTarget: "available desktops" }
          };
        const entry = computers.require(call.params.desktop_ref);
        return {
          identity: systemRouteBindingIdentity(entry.route),
          metadata: systemRouteMetadata(entry.route)
        };
      }
    }
  }));
}

// plugins/system/source/host-dispatch.ts
var defaultSystemHostConnection = {
  readHostStatus,
  executeHostOperation
};
function createBoundSystemHandlers(input) {
  return Object.fromEntries(
    HOST_OPERATIONS.map((operation) => [
      operation,
      boundOperation(input, operation)
    ])
  );
}
function boundOperation(input, operation) {
  return async (params, context) => {
    if (hasConnectionControl(params))
      return failureResult({
        errorCode: "system_connection_control_forbidden",
        message: "Connection selection is managed internally and is not an operation input."
      });
    if (operation === "system_targets") {
      const observation = observeCapturedSystemTargets(input.snapshot);
      return successResult({
        output: JSON.stringify(observation),
        data: {
          ...observation,
          observationMeta: { kind: "volatile_external", carryPolicy: "never" }
        }
      });
    }
    try {
      const route = requireSystemRequestRoute(input.snapshot, params.target);
      if (route.kind === "native")
        return await input.nativeHandlers[operation](params, context);
      return await input.connection.executeHostOperation(input.rootDir, {
        hostId: route.hostId,
        connectionId: route.connectionId,
        operation,
        params,
        ...context?.abortSignal ? { abortSignal: context.abortSignal } : {}
      });
    } catch (error) {
      if (error instanceof SystemOperationError)
        return failureResult({ errorCode: error.code, message: error.message });
      return failureResult({
        errorCode: "system_execution_route_failed",
        message: "The bound execution route failed. No other destination was attempted; effects may be partial if dispatch began."
      });
    }
  };
}
function hasConnectionControl(params) {
  if (Object.hasOwn(params, "host_id")) return true;
  if (Object.hasOwn(params, "hostId")) return true;
  return Object.hasOwn(params, "connectionId");
}

// plugins/system/source/request-system-modules.ts
async function prepareSystemRequestModules(rootDir, modules, dependencies = {}, preparation) {
  if (modules.length === 0) return Object.freeze([]);
  if (modules.some(isUnsupportedSystemModule))
    throw new Error("system_request_module_unknown");
  const connection = dependencies.connection ?? defaultSystemHostConnection;
  const candidates = await captureSystemTargetSnapshot({
    observeTargets: dependencies.observeTargets ?? observeSystemTargets,
    readHostStatus: () => connection.readHostStatus(rootDir),
    includeSameOsCompanion: true
  });
  const snapshot = uniqueSystemCommandRoutes(candidates);
  const computerModules = prepareComputerModules(
    rootDir,
    modules.filter((module2) => isComputerTool(module2.definition.name)),
    candidates,
    connection,
    preparation
  );
  const hasCommandTargets = snapshot.length > 0;
  if (!hasCommandTargets) return Object.freeze(computerModules);
  const createNative = dependencies.createNativeHandlers ?? ((resolve) => createSystemHandlers(void 0, resolve));
  const nativeHandlers = createNative(
    async (target) => resolveCapturedNativeTarget(snapshot, target)
  );
  const handlers = createBoundSystemHandlers({
    rootDir,
    snapshot,
    connection,
    nativeHandlers
  });
  return Object.freeze([
    ...modules.filter((module2) => !isComputerTool(module2.definition.name)).map((module2) => projectSystemRequestModule(module2, snapshot, handlers)),
    ...computerModules
  ]);
}
function isUnsupportedSystemModule(module2) {
  if (isHostOperation(module2.definition.name)) return false;
  return !isComputerTool(module2.definition.name);
}
function uniqueSystemCommandRoutes(candidates) {
  const seen = /* @__PURE__ */ new Set();
  return candidates.filter((route) => {
    const target = routeTargetId(route);
    if (seen.has(target)) return false;
    seen.add(target);
    return true;
  });
}
function projectSystemRequestModule(module2, snapshot, handlers) {
  const targets = Object.freeze(snapshot.map(routeTargetId));
  const availability = ` Available targets for this request: ${targets.join(", ")}.`;
  return Object.freeze({
    ...module2,
    normalInvocation: {
      ...module2.normalInvocation,
      operations: module2.normalInvocation.operations.map((operation) => ({
        ...operation,
        summary: operation.summary + availability,
        input: {
          ...operation.input,
          properties: {
            ...operation.input.properties,
            ...Object.hasOwn(operation.input.properties, "target") ? { target: { type: "string", enum: targets } } : {}
          }
        }
      }))
    },
    implementation: handlers[module2.definition.name],
    adapter: {
      ...module2.adapter,
      executionBinding: systemExecutionBinding(snapshot)
    }
  });
}
function systemExecutionBinding(snapshot) {
  return (call) => {
    if (call.tool === "system_targets")
      return {
        identity: JSON.stringify(snapshot.map(systemRouteBindingIdentity)),
        metadata: { displayTarget: snapshot.map(routeTargetId).join(", ") }
      };
    const route = requireSystemRequestRoute(snapshot, call.params.target);
    return {
      identity: systemRouteBindingIdentity(route),
      metadata: systemRouteMetadata(route)
    };
  };
}

// plugins/system/source/index.ts
var index_default = defineRuntimePlugin(({ rootDir }) => ({
  handlers: { ...createSystemHandlers(), ...unboundComputerHandlers() },
  prepareRequest: (modules, preparation) => prepareSystemRequestModules(rootDir, modules, {}, preparation)
}));
