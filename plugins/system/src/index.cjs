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

// plugins/system/source/application-catalog.ts
var import_promises2 = require("node:fs/promises");
var import_node_os2 = require("node:os");
var import_node_path2 = require("node:path");

// plugins/system/source/contracts.ts
var SystemOperationError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
  code;
};

// plugins/system/source/targets.ts
var import_node_fs2 = require("node:fs");
var import_promises = require("node:fs/promises");
var import_node_path = require("node:path");

// plugins/system/source/process-runner.ts
var import_node_child_process = require("node:child_process");
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
    const child = (0, import_node_child_process.spawn)(input.executable, [...input.args], {
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

// plugins/system/source/host-observation.ts
var import_node_fs = require("node:fs");
var import_node_os = require("node:os");
function readSystemHostFacts() {
  return {
    platform: process.platform,
    kernelRelease: (0, import_node_os.release)(),
    containerMarker: hasSystemContainerMarker()
  };
}
function hasSystemContainerMarker() {
  if ((0, import_node_fs.existsSync)("/.dockerenv")) return true;
  return (0, import_node_fs.existsSync)("/run/.containerenv");
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

// plugins/system/source/targets.ts
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
    ...(process.env.PATH ?? "").split(import_node_path.delimiter).filter(Boolean).map((directory) => (0, import_node_path.join)(directory, name))
  ];
  for (const candidate of candidates) {
    try {
      await (0, import_promises.access)(candidate, import_node_fs2.constants.X_OK);
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
  const canonicalShell = nativeWindows ? (0, import_node_path.join)(
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
    await (0, import_promises.access)("/bin/bash", import_node_fs2.constants.X_OK);
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

// plugins/system/source/application-catalog.ts
var CATALOG_ENTRY_LIMIT = 2e3;
function isAbsentOptionalCatalogRoot(error, depth) {
  if (depth !== 0 || !(error instanceof Error)) return false;
  return "code" in error && error.code === "ENOENT";
}
async function readApplicationDirectory(path, depth) {
  try {
    return {
      entries: await (0, import_promises2.readdir)(path, { withFileTypes: true }),
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
      const absolute = (0, import_node_path2.join)(current.path, entry.name);
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
      (0, import_node_path2.join)((0, import_node_os2.homedir)(), "Applications")
    ];
    const catalog2 = await collectApplicationPaths(roots2, ".app");
    return {
      applications: catalog2.paths.map((id) => ({
        id,
        name: (0, import_node_path2.basename)(id, ".app"),
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
  const dataHome = process.env.XDG_DATA_HOME ?? (0, import_node_path2.join)((0, import_node_os2.homedir)(), ".local", "share");
  const dataDirs = (process.env.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share").split(":");
  const roots = [dataHome, ...dataDirs].map(
    (directory) => (0, import_node_path2.join)(directory, "applications")
  );
  const catalog = await collectApplicationPaths(roots, ".desktop");
  const applications = [];
  let complete = catalog.complete;
  for (const path of catalog.paths) {
    let content;
    try {
      content = await (0, import_promises2.readFile)(path, "utf8");
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

// plugins/system/source/application-observation.ts
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

// plugins/system/source/target-observation.ts
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

// plugins/system/source/application-launch.ts
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

// plugins/system/source/commands.ts
var import_promises3 = require("node:fs/promises");
var import_node_path3 = require("node:path");

// plugins/system/source/elevation.ts
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

// plugins/system/source/commands.ts
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
  const absoluteCwd = target.id === "windows" ? hasExplicitWindowsDirectory(cwd) : (0, import_node_path3.isAbsolute)(cwd);
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
  const directory = await (0, import_promises3.stat)(cwd).catch(() => void 0);
  if (directory?.isDirectory()) return;
  throw new SystemOperationError(
    "system_cwd_unavailable",
    "The selected target directory is unavailable or not a directory."
  );
}

// plugins/system/source/process-result.ts
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

// plugins/system/source/handlers.ts
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

// plugins/system/source/companion/protocol.ts
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

// plugins/system/source/companion/broker-client.ts
var import_node_net = require("node:net");

// plugins/system/source/companion/broker-location.ts
var import_node_crypto2 = require("node:crypto");
var import_node_fs4 = require("node:fs");
var import_node_path5 = require("node:path");
var import_node_os3 = require("node:os");

// plugins/system/source/companion/private-store.ts
var import_node_crypto = require("node:crypto");
var import_node_fs3 = require("node:fs");
var import_node_path4 = require("node:path");
function hostStateDirectory(rootDir) {
  return (0, import_node_path4.join)(rootDir, ".runtime", "system-host");
}
function ensureHostStateDirectory(directory) {
  (0, import_node_fs3.mkdirSync)(directory, { recursive: true, mode: 448 });
  const stat2 = (0, import_node_fs3.lstatSync)(directory);
  if (!stat2.isDirectory()) throw new Error("host_state_directory_invalid");
  if (process.platform === "win32") return;
  if (stat2.uid !== process.getuid?.())
    throw new Error("host_state_owner_invalid");
  if ((stat2.mode & 63) !== 0)
    throw new Error("host_state_directory_not_private");
}
function readHostPrivateJson(path) {
  try {
    const stat2 = (0, import_node_fs3.lstatSync)(path);
    if (!stat2.isFile()) throw new Error("host_state_file_invalid");
    if (process.platform !== "win32") {
      if (stat2.uid !== process.getuid?.())
        throw new Error("host_state_owner_invalid");
      if ((stat2.mode & 63) !== 0)
        throw new Error("host_state_file_not_private");
    }
    if (stat2.size > 16384) throw new Error("host_state_file_too_large");
    return JSON.parse((0, import_node_fs3.readFileSync)(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw error;
  }
}
function writeHostPrivateJson(path, value) {
  ensureHostStateDirectory((0, import_node_path4.dirname)(path));
  const temporary = `${path}.${(0, import_node_crypto.randomUUID)()}.tmp`;
  try {
    (0, import_node_fs3.writeFileSync)(temporary, JSON.stringify(value), {
      flag: "wx",
      mode: 384
    });
    (0, import_node_fs3.renameSync)(temporary, path);
  } finally {
    try {
      (0, import_node_fs3.unlinkSync)(temporary);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

// plugins/system/source/companion/broker-location.ts
function brokerRecordPath(rootDir) {
  return (0, import_node_path5.join)(hostStateDirectory(rootDir), "broker.json");
}
function brokerSocketPath(rootDir) {
  if (process.platform !== "linux")
    throw new Error("host_broker_requires_linux_runtime");
  const key = (0, import_node_crypto2.createHash)("sha256").update((0, import_node_fs4.realpathSync)(rootDir)).digest("hex").slice(0, 20);
  return (0, import_node_path5.join)(
    (0, import_node_os3.tmpdir)(),
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
  const record = readHostPrivateJson(brokerRecordPath(rootDir));
  if (record === void 0) return void 0;
  if (!isBrokerLocation(record)) throw new Error("host_broker_record_invalid");
  if (record.socketPath !== brokerSocketPath(rootDir))
    throw new Error("host_broker_path_invalid");
  return record;
}

// plugins/system/source/companion/pairing-store.ts
var import_node_crypto3 = require("node:crypto");
var import_node_path6 = require("node:path");
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
  if (value.host === void 0) return true;
  if (!isHostRecord(value.host)) return false;
  if (!isHostIdentifier(value.host.hostId)) return false;
  if (!isHostIdentity(value.host.identity)) return false;
  return typeof value.host.credentialDigest === "string";
}
var HostPairingStore = class {
  constructor(rootDir, now = Date.now) {
    this.now = now;
    this.path = (0, import_node_path6.join)(hostStateDirectory(rootDir), "pairing.json");
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
    const record = this.read();
    if (record.host && matchesToken(token, record.host.credentialDigest))
      return "credential";
    if (!record.pending) return void 0;
    if (record.pending.expiresAt <= this.now()) return void 0;
    if (matchesToken(token, record.pending.digest)) return "pairing";
    return void 0;
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

// plugins/system/source/companion/broker-client.ts
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
  if (routes.some((route) => routeTargetId(route) === remote.target))
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
    identity: Object.freeze({ ...status.identity })
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
async function prepareSystemRequestModules(rootDir, modules, dependencies = {}) {
  if (modules.length === 0) return Object.freeze([]);
  if (modules.some((module2) => !isHostOperation(module2.definition.name)))
    throw new Error("system_request_module_unknown");
  const connection = dependencies.connection ?? defaultSystemHostConnection;
  const snapshot = await captureSystemTargetSnapshot({
    observeTargets: dependencies.observeTargets ?? observeSystemTargets,
    readHostStatus: () => connection.readHostStatus(rootDir)
  });
  if (snapshot.length === 0) return Object.freeze([]);
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
  return Object.freeze(
    modules.map(
      (module2) => projectSystemRequestModule(module2, snapshot, handlers)
    )
  );
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
  handlers: createSystemHandlers(),
  prepareRequest: (modules) => prepareSystemRequestModules(rootDir, modules)
}));
