// GENERATED FILE - DO NOT EDIT.
// Source: plugins/project-orientation/source/index.ts
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

// plugins/project-orientation/source/index.ts
var index_exports = {};
__export(index_exports, {
  default: () => index_default
});
module.exports = __toCommonJS(index_exports);
var import_promises4 = require("node:fs/promises");

// src/plugin-sdk/bounds.ts
function boundText(value, options) {
  if (!Number.isSafeInteger(options.maxChars) || options.maxChars < 0) {
    throw new RangeError("maxChars must be a non-negative safe integer");
  }
  const marker = options.marker ?? "\n[truncated]";
  const truncated = value.length > options.maxChars;
  const boundedMarker = marker.slice(0, options.maxChars);
  const sourceChars = truncated ? Math.max(options.maxChars - boundedMarker.length, 0) : value.length;
  const text = truncated ? value.slice(0, sourceChars) + boundedMarker : value;
  return Object.freeze({
    text,
    metadata: Object.freeze({
      truncated,
      originalChars: value.length,
      returnedChars: text.length,
      omittedChars: Math.max(value.length - sourceChars, 0)
    })
  });
}
function sanitizeJsonText(value) {
  return [...value].map((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    const preservedWhitespace = codePoint === 9 || codePoint === 10 || codePoint === 13;
    const unsafeControl = codePoint < 32 && !preservedWhitespace || codePoint >= 127 && codePoint <= 159;
    const unpairedSurrogate = codePoint >= 55296 && codePoint <= 57343;
    return unsafeControl || unpairedSurrogate ? "�" : character;
  }).join("");
}

// src/plugin-sdk/files.ts
var import_node_fs = require("node:fs");
var import_promises = require("node:fs/promises");
var import_node_path = require("node:path");
function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("The file read was cancelled.");
  error.name = "AbortError";
  throw error;
}
async function readExact(handle, buffer, signal) {
  let offset = 0;
  while (offset < buffer.length) {
    throwIfAborted(signal);
    const result = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      offset
    );
    if (result.bytesRead === 0) return false;
    offset += result.bytesRead;
  }
  return true;
}
async function readBoundedRegularFile(absolutePath, options) {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }
  throwIfAborted(options.signal);
  if (typeof import_node_fs.constants.O_NOFOLLOW !== "number") {
    return Object.freeze({ ok: false, reason: "safe_open_unsupported" });
  }
  let handle;
  try {
    handle = await (0, import_promises.open)(
      absolutePath,
      import_node_fs.constants.O_RDONLY | import_node_fs.constants.O_NOFOLLOW
    );
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      return Object.freeze({ ok: false, reason: "not_regular_file" });
    }
    const [canonicalRoot, canonicalTarget] = await Promise.all([
      (0, import_promises.realpath)(options.rootPath),
      (0, import_promises.realpath)(absolutePath)
    ]);
    const rootRelative = (0, import_node_path.relative)(canonicalRoot, canonicalTarget);
    if (rootRelative === ".." || rootRelative.startsWith(`..${import_node_path.sep}`) || rootRelative.startsWith(import_node_path.sep)) {
      return Object.freeze({ ok: false, reason: "outside_root" });
    }
    const pathIdentity = await (0, import_promises.stat)(canonicalTarget, { bigint: true });
    if (pathIdentity.dev !== before.dev || pathIdentity.ino !== before.ino || !pathIdentity.isFile()) {
      return Object.freeze({ ok: false, reason: "changed_during_read" });
    }
    const byteCount = Number(before.size);
    if (!Number.isSafeInteger(byteCount) || byteCount < 0) {
      return Object.freeze({
        ok: false,
        reason: "too_large",
        byteCount
      });
    }
    if (byteCount > options.maxBytes) {
      return Object.freeze({
        ok: false,
        reason: "too_large",
        byteCount
      });
    }
    const bytes = Buffer.alloc(byteCount);
    if (!await readExact(handle, bytes, options.signal)) {
      return Object.freeze({
        ok: false,
        reason: "changed_during_read",
        byteCount
      });
    }
    throwIfAborted(options.signal);
    const after = await handle.stat({ bigint: true });
    if (!after.isFile() || Number(after.size) !== byteCount || after.dev !== before.dev || after.ino !== before.ino || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      return Object.freeze({
        ok: false,
        reason: "changed_during_read",
        byteCount: Number(after.size)
      });
    }
    return Object.freeze({ ok: true, bytes, byteCount });
  } finally {
    await handle?.close().catch(() => void 0);
  }
}

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
function resolvePluginPath(context, rawPath, options = {}) {
  return context.runtimePathResolver.resolve(rawPath, options);
}
function runtimeToolPathErrorCode(error) {
  if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string" || !error.code.startsWith("runtime_tool_path_")) {
    return void 0;
  }
  return error.code;
}
function isRuntimeToolPathError(error) {
  return runtimeToolPathErrorCode(error) !== void 0;
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

// plugins/project-orientation/source/manifest-summary.ts
var import_promises2 = require("node:fs/promises");
var import_node_path2 = require("node:path");
var PACKAGE_JSON_MAX_BYTES = 256 * 1024;
var PACKAGE_SCRIPT_LIMIT = 100;
var MANIFEST_IDENTITY_MAX_CHARS = 256;
var SCRIPT_NAME_MAX_CHARS = 32;
var KNOWN_MANIFESTS = Object.freeze([
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "tsconfig.json",
  "vite.config.ts",
  "vite.config.js"
]);
function logicalChild(parent, name) {
  return parent.logicalPath === "." ? name : import_node_path2.posix.join(parent.logicalPath, name);
}
function stringField(record, key) {
  const value = record[key];
  return typeof value === "string" ? sanitizeJsonText(value).slice(0, MANIFEST_IDENTITY_MAX_CHARS) : void 0;
}
function boundedScriptName(value) {
  return [...sanitizeJsonText(value)].slice(0, SCRIPT_NAME_MAX_CHARS).join("");
}
async function existingChild(context, root, name) {
  try {
    const child = resolvePluginPath(context, logicalChild(root, name), {
      requirePath: true,
      allowedLocations: ["agent_work", "workspace"]
    });
    const info = await (0, import_promises2.stat)(child.absolutePath);
    return info.isFile() ? child : void 0;
  } catch (error) {
    if (isRuntimeToolPathError(error)) throw error;
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT" || code === "ENOTDIR") return void 0;
    throw error;
  }
}
async function readProjectManifests(context, root) {
  const summaries = [];
  for (const name of KNOWN_MANIFESTS) {
    const target = await existingChild(context, root, name);
    if (!target) continue;
    if (name !== "package.json") {
      summaries.push(Object.freeze({ file: name }));
      continue;
    }
    const file = await readBoundedRegularFile(target.absolutePath, {
      maxBytes: PACKAGE_JSON_MAX_BYTES,
      rootPath: target.rootPath
    });
    if (!file.ok && file.reason === "too_large") {
      summaries.push(
        Object.freeze({ file: name, status: "too_large" })
      );
      continue;
    }
    if (!file.ok)
      throw new Error("Project manifest changed while it was being read.");
    try {
      const parsed = JSON.parse(file.bytes.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        summaries.push(
          Object.freeze({ file: name, status: "invalid_json" })
        );
        continue;
      }
      const record = parsed;
      const rawScriptNames = record.scripts && typeof record.scripts === "object" && !Array.isArray(record.scripts) ? Object.keys(record.scripts).sort(
        (left, right) => left.localeCompare(right)
      ) : [];
      const scriptNames = rawScriptNames.map(boundedScriptName);
      summaries.push(
        Object.freeze({
          file: name,
          ...stringField(record, "name") ? { name: stringField(record, "name") } : {},
          ...stringField(record, "version") ? { version: stringField(record, "version") } : {},
          ...record.private === true ? { private: true } : {},
          scripts: Object.freeze(scriptNames.slice(0, PACKAGE_SCRIPT_LIMIT)),
          ...rawScriptNames.length > PACKAGE_SCRIPT_LIMIT || rawScriptNames.some((name2, index) => name2 !== scriptNames[index]) ? { scriptsTruncated: true } : {}
        })
      );
    } catch (error) {
      if (error instanceof SyntaxError) {
        summaries.push(
          Object.freeze({ file: name, status: "invalid_json" })
        );
        continue;
      }
      throw error;
    }
  }
  return Object.freeze(summaries);
}

// plugins/project-orientation/source/tree.ts
var import_promises3 = require("node:fs/promises");
var import_node_path3 = require("node:path");
var IGNORED_NAMES = /* @__PURE__ */ new Set([".git", "node_modules", "dist", "coverage"]);
var DISPLAY_PATH_MAX_CHARS = 64;
function childLogicalPath(parent, childName) {
  if (parent.logicalPath === ".") return childName;
  return import_node_path3.posix.join(parent.logicalPath, childName);
}
function relativeDisplayPath(root, child) {
  if (child.logicalPath === root.logicalPath) return ".";
  if (root.logicalPath === ".") return child.logicalPath;
  const prefix = `${root.logicalPath}/`;
  return child.logicalPath.startsWith(prefix) ? child.logicalPath.slice(prefix.length) : child.logicalPath;
}
function boundedDisplayPath(path) {
  const characters = [...sanitizeJsonText(path)];
  if (characters.length <= DISPLAY_PATH_MAX_CHARS) {
    return Object.freeze({ path, truncated: false });
  }
  const separator = "…";
  const sideChars = Math.floor((DISPLAY_PATH_MAX_CHARS - separator.length) / 2);
  return Object.freeze({
    path: `${characters.slice(0, sideChars).join("")}${separator}${characters.slice(-sideChars).join("")}`,
    truncated: true
  });
}
async function collectProjectTree(context, root, depth, maxEntries) {
  const directories = [];
  const files = [];
  let entries = 0;
  let truncated = false;
  let truncatedPathCount = 0;
  const queue = [{ target: root, remainingDepth: depth }];
  while (queue.length > 0 && entries < maxEntries) {
    const current = queue.shift();
    if (!current) break;
    const sampled = [];
    const directory = await (0, import_promises3.opendir)(current.target.absolutePath);
    for await (const entry of directory) {
      if (entry.isDirectory() && IGNORED_NAMES.has(entry.name)) continue;
      if (entries + sampled.length >= maxEntries) {
        truncated = true;
        break;
      }
      sampled.push({ name: entry.name, isDirectory: entry.isDirectory() });
    }
    sampled.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of sampled) {
      const child = resolvePluginPath(
        context,
        childLogicalPath(current.target, entry.name),
        {
          requirePath: true,
          allowedLocations: ["agent_work", "workspace"]
        }
      );
      const info = await (0, import_promises3.stat)(child.absolutePath);
      const display = boundedDisplayPath(relativeDisplayPath(root, child));
      if (display.truncated) truncatedPathCount += 1;
      entries += 1;
      if (info.isDirectory()) {
        directories.push(display.path);
        if (current.remainingDepth > 0) {
          queue.push({
            target: child,
            remainingDepth: current.remainingDepth - 1
          });
        }
      } else if (info.isFile()) {
        files.push(display.path);
      }
    }
  }
  if (queue.length > 0) truncated = true;
  directories.sort((left, right) => left.localeCompare(right));
  files.sort((left, right) => left.localeCompare(right));
  return Object.freeze({
    directories: Object.freeze(directories),
    files: Object.freeze(files),
    entries,
    truncated,
    truncatedPathCount,
    sampling: "bounded_directory_iteration"
  });
}

// plugins/project-orientation/source/index.ts
var DEFAULT_DEPTH = 3;
var DEFAULT_MAX_ENTRIES = 200;
var MAX_DEPTH = 6;
var MAX_ENTRIES = 250;
var OUTPUT_MAX_CHARS = 8e3;
var index_default = defineRuntimePlugin((context) => {
  const defaultDepth = readBoundedInteger(context.config?.defaultDepth, {
    defaultValue: DEFAULT_DEPTH,
    minimum: 0,
    maximum: MAX_DEPTH,
    name: "defaultDepth"
  });
  const defaultMaxEntries = readBoundedInteger(context.config?.maxEntries, {
    defaultValue: DEFAULT_MAX_ENTRIES,
    minimum: 1,
    maximum: MAX_ENTRIES,
    name: "maxEntries"
  });
  return {
    handlers: {
      async inspect_project(params) {
        try {
          const requestedPath = readOptionalString(params.path) ?? ".";
          const target = resolvePluginPath(context, requestedPath, {
            defaultPath: ".",
            allowedLocations: ["agent_work", "workspace"]
          });
          const info = await (0, import_promises4.stat)(target.absolutePath);
          if (!info.isDirectory()) {
            return failureResult({
              errorCode: "project_target_not_directory",
              message: "The requested project target is not a directory."
            });
          }
          const depth = readBoundedInteger(params.depth, {
            defaultValue: defaultDepth,
            minimum: 0,
            maximum: MAX_DEPTH,
            name: "depth"
          });
          const maxEntries = readBoundedInteger(params.maxEntries, {
            defaultValue: defaultMaxEntries,
            minimum: 1,
            maximum: MAX_ENTRIES,
            name: "maxEntries"
          });
          const [tree, manifests] = await Promise.all([
            collectProjectTree(context, target, depth, maxEntries),
            readProjectManifests(context, target)
          ]);
          const packageManifest = manifests.find(
            ({ file }) => file === "package.json"
          );
          const rawOutput = [
            `Project target: ${target.logicalPath}`,
            `Directories (${tree.directories.length}${tree.truncated ? ", bounded sample" : ""}): ${tree.directories.join(", ") || "none"}`,
            `Files (${tree.files.length}${tree.truncated ? ", bounded sample" : ""}): ${tree.files.join(", ") || "none"}`,
            `Manifests: ${manifests.map(({ file }) => file).join(", ") || "none"}`,
            packageManifest?.scripts?.length ? `Package scripts: ${packageManifest.scripts.join(", ")}` : ""
          ].filter(Boolean).join("\n");
          const output = boundText(rawOutput, {
            maxChars: OUTPUT_MAX_CHARS,
            marker: "\n[project orientation output truncated]"
          });
          return successResult({
            output: output.text,
            producedNewInformation: true,
            data: {
              location: target.location,
              target: target.logicalPath,
              depth,
              maxEntries,
              tree,
              manifests,
              truncation: {
                output: output.metadata,
                tree: tree.truncated,
                pathCount: tree.truncatedPathCount
              },
              observationMeta: {
                kind: "volatile_external",
                carryPolicy: "never"
              }
            }
          });
        } catch (error) {
          return failureFromError(error, {
            fallbackCode: "project_orientation_failed",
            fallbackMessage: "Project orientation failed.",
            operation: "inspect_project"
          });
        }
      }
    }
  };
});
