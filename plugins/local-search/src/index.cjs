// GENERATED FILE - DO NOT EDIT.
// Source: plugins/local-search/source/index.ts
// Run "npm run build:plugins" after editing plugin source.
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
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

// src/shared/windows-file-io/native-script.ts
var WINDOWS_FILESYSTEM_NATIVE;
var init_native_script = __esm({
  "src/shared/windows-file-io/native-script.ts"() {
    "use strict";
    WINDOWS_FILESYSTEM_NATIVE = String.raw`
using System;
using System.IO;
using System.Text;
using System.Linq;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

public sealed class FsFault : Exception {
  public readonly string Code;
  public FsFault(string code) : base(code) { Code = code; }
}
public static partial class AbotFilesystem {
  [StructLayout(LayoutKind.Sequential)] struct UnicodeString { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct ObjectAttributes {
    public int Length; public IntPtr Root, Name; public uint Attributes; public IntPtr Security, Qos;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoStatus { public IntPtr Status, Information; }
  [StructLayout(LayoutKind.Sequential)] struct BasicInfo {
    public long Created, Accessed, Modified, Changed; public uint Attributes;
  }
  [StructLayout(LayoutKind.Sequential)] struct FileInfo {
    public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Modified;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("ntdll.dll")] static extern int NtCreateFile(out SafeFileHandle file, uint access,
    ref ObjectAttributes attributes, out IoStatus status, IntPtr allocation, uint fileAttributes,
    uint share, uint disposition, uint options, IntPtr ea, uint eaLength);
  [DllImport("ntdll.dll")] static extern uint RtlNtStatusToDosError(int status);
  [DllImport("ntdll.dll")] static extern int NtSetInformationFile(SafeFileHandle file,
    out IoStatus status, IntPtr info, uint length, int kind);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInfo info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int kind, IntPtr data, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle file, int kind, ref BasicInfo info, uint length);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder name, uint length, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFilePointerEx(SafeFileHandle file, long position, out long result, uint method);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(SafeFileHandle file, byte[] bytes, uint count, out uint read, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteFile(SafeFileHandle file, byte[] bytes, uint count, out uint written, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FlushFileBuffers(SafeFileHandle file);
  [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(SafeFileHandle file, int kind, uint information,
    out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern uint SetSecurityInfo(SafeFileHandle file, int kind, uint information,
    IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetSecurityDescriptorControl(IntPtr descriptor, out ushort control, out uint revision);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);

  static void Check(bool success) { if (!success) NativeFailure((uint)Marshal.GetLastWin32Error()); }
  static bool IsNotDirectoryError(uint code) { return code == 267; } // ERROR_DIRECTORY
  static void NativeFailure(uint code) {
    if (IsNotDirectoryError(code)) throw new FsFault("not_a_directory");
    if (code == 2 || code == 3) throw new FsFault("file_not_found");
    if (code == 80 || code == 183) throw new FsFault("filesystem_target_changed");
    if (code == 5 || code == 32 || code == 33) throw new FsFault("filesystem_access_denied");
    throw new FsFault("filesystem_native_operation_failed");
  }
  static void CheckNt(int status) { if (status < 0) NativeFailure(RtlNtStatusToDosError(status)); }
  static SafeFileHandle OpenHandle(SafeFileHandle root, string name, bool directory,
    uint disposition, uint access, uint share, byte[] securityDescriptor = null, bool deleteOnClose = false) {
    IntPtr text = Marshal.StringToHGlobalUni(name), unicodePointer = IntPtr.Zero, securityPointer = IntPtr.Zero;
    try {
      int length = Encoding.Unicode.GetByteCount(name);
      if (length > 65532) throw new FsFault("filesystem_invalid_path");
      UnicodeString unicode = new UnicodeString { Length=(ushort)length, MaximumLength=(ushort)(length+2), Buffer=text };
      unicodePointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));
      Marshal.StructureToPtr(unicode, unicodePointer, false);
      if (securityDescriptor != null) {
        securityPointer = Marshal.AllocHGlobal(securityDescriptor.Length);
        Marshal.Copy(securityDescriptor, 0, securityPointer, securityDescriptor.Length);
      }
      ObjectAttributes attributes = new ObjectAttributes {
        Length=Marshal.SizeOf(typeof(ObjectAttributes)), Root=root == null ? IntPtr.Zero : root.DangerousGetHandle(),
        Name=unicodePointer, Attributes=0x40, Security=securityPointer
      };
      SafeFileHandle file;
      IoStatus status;
      int result = NtCreateFile(out file, access | 0x100000, ref attributes, out status,
        IntPtr.Zero, 0x80, share, disposition, 0x200020u | (directory ? 1u : 0x40u) | (deleteOnClose ? 0x1000u : 0u), IntPtr.Zero, 0);
      if (result < 0) { if (file != null) file.Dispose(); CheckNt(result); }
      try {
        FileInfo info; Check(GetFileInformationByHandle(file, out info));
        if ((info.Attributes & 0x400) != 0) throw new FsFault("filesystem_path_changed");
        if (((info.Attributes & 0x10) != 0) != directory) throw new FsFault("filesystem_path_changed");
        return file;
      } catch { file.Dispose(); throw; }
    } finally {
      if (securityPointer != IntPtr.Zero) Marshal.FreeHGlobal(securityPointer);
      if (unicodePointer != IntPtr.Zero) Marshal.FreeHGlobal(unicodePointer);
      Marshal.FreeHGlobal(text);
    }
  }
  static BasicInfo Basic(SafeFileHandle file) {
    IntPtr buffer = Marshal.AllocHGlobal(40);
    try { Check(GetFileInformationByHandleEx(file, 0, buffer, 40)); return (BasicInfo)Marshal.PtrToStructure(buffer, typeof(BasicInfo)); }
    finally { Marshal.FreeHGlobal(buffer); }
  }
  static Dictionary<string,object> Record(params object[] pairs) {
    var result = new Dictionary<string,object>();
    for (int i=0;i<pairs.Length;i+=2) result.Add((string)pairs[i], pairs[i+1]);
    return result;
  }
  static string Text(Dictionary<string,object> request, string key) {
    object value;
    if (!request.TryGetValue(key, out value) || !(value is string)) throw new FsFault("filesystem_invalid_request");
    return (string)value;
  }
  static int Limit(Dictionary<string,object> request, string key, int maximum) {
    object value;
    if (!request.TryGetValue(key, out value) || !(value is int)) throw new FsFault("filesystem_invalid_request");
    int number = (int)value;
    if (number < 0 || number > maximum) throw new FsFault("filesystem_invalid_request");
    return number;
  }
}
`;
  }
});

// src/shared/windows-file-io/authority-script.ts
var WINDOWS_FILESYSTEM_AUTHORITY;
var init_authority_script = __esm({
  "src/shared/windows-file-io/authority-script.ts"() {
    "use strict";
    WINDOWS_FILESYSTEM_AUTHORITY = String.raw`
public static partial class AbotFilesystem {
  static string NativePath(string path) {
    string full = Path.GetFullPath(path);
    if (full.StartsWith(@"\\?\") || full.StartsWith(@"\\.\")) throw new FsFault("filesystem_invalid_path");
    if (full.StartsWith(@"\\")) return @"\??\UNC\" + full.Substring(2);
    if (full.Length < 3 || full[1] != ':' || full[2] != '\\') throw new FsFault("filesystem_invalid_path");
    return @"\??\" + full;
  }
  static string FinalPath(SafeFileHandle handle) {
    var value = new StringBuilder(32768);
    uint length = GetFinalPathNameByHandle(handle, value, (uint)value.Capacity, 0);
    Check(length != 0);
    if (length >= value.Capacity) throw new FsFault("filesystem_invalid_path");
    string path = value.ToString();
    if (path.StartsWith(@"\\?\UNC\")) return @"\\" + path.Substring(8);
    if (path.StartsWith(@"\\?\")) return path.Substring(4);
    throw new FsFault("filesystem_path_changed");
  }
  static SafeFileHandle OpenRoot(Dictionary<string,object> request) {
    string path = Path.GetFullPath(Text(request, "rootPath"));
    SafeFileHandle root = OpenHandle(null, NativePath(path), true, 1, 0x80000000, 7);
    try {
      if (!String.Equals(FinalPath(root).TrimEnd('\\'), path.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
        throw new FsFault("filesystem_path_changed");
      var expected = request["rootIdentity"] as Dictionary<string,object>;
      if (expected == null || !MatchesIdentity(Identity(root), expected)) throw new FsFault("filesystem_path_changed");
      return root;
    } catch { root.Dispose(); throw; }
  }
  static string[] Components(Dictionary<string,object> request) {
    string relative = Text(request, "relativePath");
    if (relative == "") return new string[0];
    string[] parts = relative.Split('/');
    foreach (string part in parts) ValidateComponent(part);
    return parts;
  }
  static void ValidateComponent(string name) {
    if (name.Length == 0 || name == "." || name == "..") throw new FsFault("filesystem_invalid_path");
    if (name.EndsWith(".") || name.EndsWith(" ")) throw new FsFault("filesystem_invalid_path");
    foreach (char c in name) {
      if (c < 32 || "\\/:*?\"<>|".IndexOf(c) >= 0) throw new FsFault("filesystem_invalid_path");
    }
    string stem = name.Split('.')[0].ToUpperInvariant();
    if (stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL" ||
      stem == "CONIN$" || stem == "CONOUT$") throw new FsFault("filesystem_invalid_path");
    if (stem.Length == 4 && (stem.StartsWith("COM") || stem.StartsWith("LPT")) &&
      "123456789\u00b9\u00b2\u00b3".IndexOf(stem[3]) >= 0) throw new FsFault("filesystem_invalid_path");
  }
  sealed class DirectoryChain : IDisposable {
    public readonly SafeFileHandle Root;
    readonly List<SafeFileHandle> children = new List<SafeFileHandle>();
    public SafeFileHandle Current { get { return children.Count == 0 ? Root : children[children.Count-1]; } }
    public DirectoryChain(Dictionary<string,object> request) { Root = OpenRoot(request); }
    public void Walk(string[] parts, int count, bool create) {
      for (int i=0;i<count;i++) children.Add(OpenHandle(Current, parts[i], true, create ? 3u : 1u, 0x80000000, 7));
    }
    public void Dispose() { for (int i=children.Count-1;i>=0;i--) children[i].Dispose(); Root.Dispose(); }
  }
  static ulong FileId(FileInfo info) {
    ulong id=((ulong)info.IndexHigh << 32) | info.IndexLow;
    if (id == 0) throw new FsFault("filesystem_safe_io_unsupported");
    return id;
  }
  static Dictionary<string,object> Identity(SafeFileHandle file) {
    FileInfo info; Check(GetFileInformationByHandle(file, out info));
    BasicInfo basic = Basic(file);
    return Record("device", info.Volume.ToString(), "inode", FileId(info).ToString(),
      "birthtimeNs", ((basic.Created - 116444736000000000L) * 100L).ToString());
  }
  static bool MatchesIdentity(Dictionary<string,object> left, Dictionary<string,object> right) {
    foreach (string key in new [] {"device", "inode", "birthtimeNs"}) {
      if (!right.ContainsKey(key) || !Object.Equals(left[key], right[key])) return false;
    }
    return true;
  }
  static Dictionary<string,object> Metadata(SafeFileHandle file) {
    FileInfo info; Check(GetFileInformationByHandle(file, out info));
    BasicInfo basic = Basic(file);
    ulong size = ((ulong)info.SizeHigh << 32) | info.SizeLow;
    if (size > 9007199254740991UL) throw new FsFault("file_too_large");
    return Record("device", info.Volume.ToString(), "inode", FileId(info).ToString(),
      "size", (long)size, "mode", (basic.Attributes & 1) != 0 ? 292 : 438,
      "modifiedNs", ((basic.Modified - 116444736000000000L) * 100L).ToString(),
      "changedNs", ((basic.Changed - 116444736000000000L) * 100L).ToString());
  }
  static bool SameMetadata(Dictionary<string,object> left, Dictionary<string,object> right) {
    foreach (string key in new [] {"device", "inode", "size", "mode", "modifiedNs", "changedNs"}) {
      if (!right.ContainsKey(key) || Convert.ToString(left[key]) != Convert.ToString(right[key])) return false;
    }
    return true;
  }
}
`;
  }
});

// plugins/local-search/source/index.ts
var index_exports = {};
__export(index_exports, {
  default: () => index_default
});
module.exports = __toCommonJS(index_exports);
var import_node_path5 = require("node:path");

// src/plugin-sdk/bounds.ts
function sanitizeJsonText(value) {
  return [...value].map((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    const preservedWhitespace = codePoint === 9 || codePoint === 10 || codePoint === 13;
    const unsafeControl = codePoint < 32 && !preservedWhitespace || codePoint >= 127 && codePoint <= 159;
    const unpairedSurrogate = codePoint >= 55296 && codePoint <= 57343;
    return unsafeControl || unpairedSurrogate ? "�" : character;
  }).join("");
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
function readBoolean(value, options = {}) {
  const parameter = parameterName(options);
  const candidate = value === void 0 ? options.defaultValue : value;
  if (typeof candidate !== "boolean") {
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

// src/plugin-sdk/plugin.ts
function defineRuntimePlugin(definition) {
  return definition;
}

// src/capabilities/tool-context-text.ts
function hasValidToolContextText(carrier) {
  const fields = carrier.contextTextFields;
  if (fields === void 0) return true;
  if (!Array.isArray(fields) || fields.length === 0 || fields.length > 3)
    return false;
  if (new Set(fields).size !== fields.length) return false;
  for (const field of fields) {
    if (!isContextTextField(field)) return false;
    if (typeof carrier[field] !== "string") return false;
  }
  return true;
}
function isContextTextField(value) {
  return value === "output" || value === "stdout" || value === "stderr";
}

// src/capabilities/result-budget.ts
var CAPABILITY_RESULT_ENVELOPE_MAX_BYTES = 256 * 1024;

// src/plugin-sdk/results.ts
var PLUGIN_RESULT_SERIALIZED_MAX_BYTES = CAPABILITY_RESULT_ENVELOPE_MAX_BYTES;
function resultBoundsFailure(code, message) {
  return {
    ok: false,
    output: message,
    producedNewInformation: false,
    error: message,
    errorCode: code
  };
}
function enforcePluginResultByteBudget(result, resultBudget) {
  let requiresContextTextHost = false;
  let serializedBytes;
  let envelopeBytes;
  let maxBytes = PLUGIN_RESULT_SERIALIZED_MAX_BYTES;
  let fitsDeclaredBudget = true;
  try {
    if (!hasValidToolContextText(result)) {
      return resultBoundsFailure(
        "plugin_context_text_invalid",
        "The plugin declared invalid context text fields."
      );
    }
    requiresContextTextHost = result.contextTextFields !== void 0;
    const lacksContextTextHost = requiresContextTextHost && resultBudget?.acceptsContextText !== true;
    if (lacksContextTextHost) {
      return resultBoundsFailure(
        "plugin_context_text_unavailable",
        "The host does not support context-managed tool text."
      );
    }
    const candidate = JSON.stringify(result);
    if (candidate === void 0) {
      return resultBoundsFailure(
        "plugin_result_not_json_safe",
        "The plugin produced a result that is not JSON-safe."
      );
    }
    const assessment = resultBudget?.assess(result);
    serializedBytes = assessment?.serializedBytes ?? Buffer.byteLength(candidate, "utf8");
    envelopeBytes = assessment?.envelopeBytes ?? serializedBytes;
    maxBytes = Math.min(assessment?.maxBytes ?? maxBytes, maxBytes);
    fitsDeclaredBudget = assessment?.fits ?? true;
  } catch {
    return resultBoundsFailure(
      "plugin_result_not_json_safe",
      "The plugin produced a result that is not JSON-safe."
    );
  }
  const hasResultDeliveryHeadroom = fitsDeclaredBudget && envelopeBytes <= maxBytes;
  if (!hasResultDeliveryHeadroom) {
    const message = requiresContextTextHost ? `The plugin result envelope is ${envelopeBytes} bytes (${serializedBytes} total bytes) and exceeds the ${maxBytes}-byte delivery limit.` : `The plugin result is ${serializedBytes} bytes and exceeds the ${maxBytes}-byte delivery limit.`;
    return resultBoundsFailure("plugin_result_too_large", message);
  }
  return result;
}
function successResult(input, resultBudget) {
  return enforcePluginResultByteBudget(
    {
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
    },
    resultBudget
  );
}
function failureResult(input, resultBudget) {
  return enforcePluginResultByteBudget(
    {
      ok: false,
      ...input.interruption ? { interruption: input.interruption } : {},
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
    },
    resultBudget
  );
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

// plugins/local-search/source/errors.ts
var LocalSearchError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "LocalSearchError";
    this.code = code;
  }
};
function isLocalSearchError(error) {
  return error instanceof LocalSearchError;
}

// plugins/local-search/source/output.ts
var MAX_OUTPUT_CHARS = 32768;
function display(value) {
  return JSON.stringify(value).slice(1, -1);
}
function render(params) {
  const names = params.entries.filter(
    (entry) => entry.kind === "name"
  ).map(({ value }) => `- ${display(value)}`);
  const content = params.entries.filter(
    (entry) => entry.kind === "content"
  ).map(
    ({ value }) => `- ${display(value.path)}:${value.lineNumber}:${sanitizeJsonText(value.text)}`
  );
  return [
    'Search scope: selected logical path; use "." for the current Worker root.',
    `Query: ${sanitizeJsonText(params.query)}`,
    `Mode: ${params.mode}`,
    `Returned matches: ${params.entries.length}${params.truncated ? " (bounded)" : ""}`,
    ...names.length > 0 ? ["Filename matches:", ...names] : [],
    ...content.length > 0 ? ["Content matches:", ...content] : [],
    ...params.entries.length === 0 ? ["No matches found."] : [],
    ...params.truncated ? ["Additional matches were omitted."] : []
  ].join("\n");
}
function budgetSearchOutput(query, mode, candidates, sourceTruncated, fitsSerializedResult) {
  const build = (entries2) => {
    const truncated = sourceTruncated || entries2.length < candidates.length;
    return Object.freeze({
      output: render({ query, mode, entries: entries2, truncated }),
      entries: Object.freeze([...entries2]),
      metadata: Object.freeze({
        truncated,
        sourceTruncated,
        candidateItems: candidates.length,
        returnedItems: entries2.length,
        outputMaxChars: MAX_OUTPUT_CHARS
      })
    });
  };
  const entries = [];
  for (const candidate of candidates) {
    const tentative = [...entries, candidate];
    const budgeted = build(tentative);
    if (budgeted.output.length > MAX_OUTPUT_CHARS || !fitsSerializedResult(budgeted)) {
      break;
    }
    entries.push(candidate);
  }
  const result = build(entries);
  if (!fitsSerializedResult(result)) {
    throw new RangeError(
      "The local-search result envelope exceeds its budget."
    );
  }
  return result;
}

// plugins/local-search/source/paths.ts
var import_node_fs = require("node:fs");
var import_promises2 = require("node:fs/promises");
var import_node_path2 = __toESM(require("node:path"), 1);

// plugins/local-search/source/windows-authority.ts
var import_promises = require("node:fs/promises");
var import_node_path = require("node:path");
function identity(stats) {
  return {
    device: String(stats.dev),
    inode: String(stats.ino),
    birthtimeNs: String(stats.birthtimeNs)
  };
}
function sameWindowsPath(left, right) {
  return import_node_path.win32.resolve(left).toLowerCase() === import_node_path.win32.resolve(right).toLowerCase();
}
function windowsSearchAuthorityUnavailable() {
  return new LocalSearchError(
    "local_search_authority_unavailable",
    "Local search could not keep the selected Windows path safely bound to its authorized root. No results were returned. Do not retry or bypass this restriction with another tool; ask the user to check the path and access permissions."
  );
}
async function openWindowsSearchAuthority(target) {
  const handles = [];
  try {
    const root = await (0, import_promises.open)(target.rootPath, "r");
    handles.push(root);
    const selected = await (0, import_promises.open)(target.absolutePath, "r");
    handles.push(selected);
    const [rootStats, selectedStats, rootPath, targetPath] = await Promise.all([
      root.stat({ bigint: true }),
      selected.stat({ bigint: true }),
      (0, import_promises.realpath)(target.rootPath),
      (0, import_promises.realpath)(target.absolutePath)
    ]);
    if (!rootStats.isDirectory()) throw windowsSearchAuthorityUnavailable();
    if (!sameWindowsPath(rootPath, target.rootPath))
      throw windowsSearchAuthorityUnavailable();
    if (!sameWindowsPath(targetPath, target.absolutePath))
      throw windowsSearchAuthorityUnavailable();
    if (!selectedStats.isFile() && !selectedStats.isDirectory()) {
      throw new LocalSearchError(
        "local_search_target_invalid",
        "The selected search target must be a regular file or directory."
      );
    }
    const isFile = selectedStats.isFile();
    return Object.freeze({
      target,
      isFile,
      commandDirectory: isFile ? import_node_path.win32.dirname(targetPath) : targetPath,
      commandTarget: isFile ? import_node_path.win32.basename(targetPath) : ".",
      directoryAuthority: {
        platform: "win32",
        rootPath,
        targetPath,
        rootIdentity: identity(rootStats),
        targetIdentity: identity(selectedStats),
        isFile
      },
      close: async () => {
        for (const handle of handles.splice(0)) await handle.close();
      }
    });
  } catch (error) {
    await Promise.all(handles.splice(0).map((handle) => handle.close()));
    if (error instanceof LocalSearchError) throw error;
    const code = error?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new LocalSearchError(
        "local_search_root_not_found",
        "The selected logical search root does not exist."
      );
    }
    throw windowsSearchAuthorityUnavailable();
  }
}

// plugins/local-search/source/paths.ts
function fsCode(error) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : void 0;
}
function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.isFile() === right.isFile() && left.isDirectory() === right.isDirectory();
}
function isWithinRoot(root, target) {
  const relative = import_node_path2.default.relative(root, target);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${import_node_path2.default.sep}`) && !import_node_path2.default.isAbsolute(relative);
}
function authorityUnavailable() {
  return new LocalSearchError(
    "local_search_failed",
    "Local search could not establish a safe read authority for the selected logical root."
  );
}
async function openSearchAuthority(target) {
  const supportsSearchAuthority = ["linux", "darwin"].includes(
    process.platform
  );
  if (!supportsSearchAuthority) throw authorityUnavailable();
  const supportsAuthorityOpenFlags = Number.isInteger(import_node_fs.constants.O_NOFOLLOW) && Number.isInteger(import_node_fs.constants.O_NONBLOCK);
  if (!supportsAuthorityOpenFlags) {
    throw authorityUnavailable();
  }
  let handle;
  let targetOpened = false;
  try {
    handle = await (0, import_promises2.open)(
      target.absolutePath,
      import_node_fs.constants.O_RDONLY | import_node_fs.constants.O_NOFOLLOW | import_node_fs.constants.O_NONBLOCK
    );
    targetOpened = true;
    const observed = await handle.stat({ bigint: true });
    if (!observed.isFile() && !observed.isDirectory()) {
      throw new LocalSearchError(
        "local_search_target_invalid",
        "The selected search target must be a regular file or directory."
      );
    }
    const [canonicalRoot, canonicalTarget] = await Promise.all([
      (0, import_promises2.realpath)(target.rootPath),
      (0, import_promises2.realpath)(target.absolutePath)
    ]);
    if (import_node_path2.default.resolve(canonicalRoot) !== import_node_path2.default.resolve(target.rootPath) || import_node_path2.default.resolve(canonicalTarget) !== import_node_path2.default.resolve(target.absolutePath) || !isWithinRoot(canonicalRoot, canonicalTarget)) {
      throw authorityUnavailable();
    }
    const [pathIdentity, descriptorIdentity] = await Promise.all([
      (0, import_promises2.stat)(canonicalTarget, { bigint: true }),
      process.platform === "linux" ? (0, import_promises2.stat)(`/proc/self/fd/${handle.fd}`, { bigint: true }) : handle.stat({ bigint: true })
    ]);
    if (!sameIdentity(observed, pathIdentity) || !sameIdentity(observed, descriptorIdentity)) {
      throw authorityUnavailable();
    }
    const authority = handle;
    const isFile = observed.isFile();
    const needsDirectoryBridge = !isFile && process.platform === "darwin";
    let commandDirectory = "/";
    if (!isFile) {
      commandDirectory = process.platform === "linux" ? `/proc/self/fd/${authority.fd}` : canonicalTarget;
    }
    let closed = false;
    handle = void 0;
    return Object.freeze({
      target,
      isFile,
      commandDirectory,
      commandTarget: isFile ? "-" : ".",
      ...isFile ? { stdinFd: authority.fd } : {},
      ...needsDirectoryBridge ? {
        directoryAuthority: {
          directoryPath: canonicalTarget,
          directoryFd: authority.fd
        }
      } : {},
      close: async () => {
        if (closed) return;
        closed = true;
        await authority.close();
      }
    });
  } catch (error) {
    await handle?.close().catch(() => void 0);
    if (error instanceof LocalSearchError) throw error;
    const code = fsCode(error);
    if (!targetOpened && (code === "ENOENT" || code === "ENOTDIR")) {
      throw new LocalSearchError(
        "local_search_root_not_found",
        "The selected logical search root does not exist."
      );
    }
    throw authorityUnavailable();
  }
}
async function resolveSearchRoot(context, rawPath) {
  const requested = typeof rawPath === "string" && rawPath.trim() ? rawPath : ".";
  const target = resolvePluginPath(context, requested, {
    requirePath: true,
    allowedLocations: ["agent_work", "workspace"]
  });
  const needsWindowsSearchAuthority = process.platform === "win32";
  if (needsWindowsSearchAuthority) return openWindowsSearchAuthority(target);
  return openSearchAuthority(target);
}
function normalizeRelativeResult(value) {
  const normalized = import_node_path2.default.sep === "/" ? value : value.replaceAll(import_node_path2.default.sep, "/");
  if (!normalized || normalized.includes("\\") || import_node_path2.default.isAbsolute(normalized) || /^[A-Za-z]:[\\/]/u.test(normalized) || /^[\\/]{2}/u.test(normalized)) {
    throw new LocalSearchError(
      "local_search_path_roundtrip_unsafe",
      "Local search found a path that cannot be reused as a logical path."
    );
  }
  return normalized.replace(/^\.\/+/, "");
}
function qualifyMatchPath(context, root, rawPath) {
  const logical = root.isFile ? root.target.logicalPath : root.target.logicalPath === "." ? normalizeRelativeResult(rawPath) : import_node_path2.default.posix.join(
    root.target.logicalPath,
    normalizeRelativeResult(rawPath)
  );
  const roundTrip = resolvePluginPath(context, logical, {
    requirePath: true,
    allowedLocations: ["agent_work", "workspace"]
  });
  const sourceAbsolutePath = root.isFile ? root.target.absolutePath : import_node_path2.default.resolve(root.target.absolutePath, rawPath);
  if (roundTrip.logicalPath !== logical || import_node_path2.default.resolve(roundTrip.absolutePath) !== import_node_path2.default.resolve(sourceAbsolutePath)) {
    throw new LocalSearchError(
      "local_search_path_roundtrip_unsafe",
      "Local search found a path that cannot be reused as a logical path."
    );
  }
  return logical;
}

// plugins/local-search/source/ripgrep.ts
var import_node_util = require("node:util");

// plugins/local-search/source/ripgrep-process.ts
var import_node_child_process3 = require("node:child_process");
var import_ripgrep = require("@vscode/ripgrep");

// src/shared/directory-authority/command.ts
var import_node_child_process = require("node:child_process");

// src/shared/directory-authority/bootstrap.ts
function directoryAuthorityBootstrap(mode, messageLimit, task) {
  const fs = require("node:fs");
  function fail(code, message) {
    throw Object.assign(new Error(message), { code });
  }
  function verifyDirectoryAuthority() {
    const expected = fs.fstatSync(3, { bigint: true });
    const actual = fs.statSync(".", { bigint: true });
    const matchesHeldDirectory = expected.isDirectory() && actual.isDirectory() && expected.dev === actual.dev && expected.ino === actual.ino;
    if (matchesHeldDirectory) return;
    fail(
      "directory_authority_changed",
      "The directory changed before the operation could establish its authority."
    );
  }
  function readRequest() {
    const fd = mode === "task" ? 0 : 4;
    const chunk = Buffer.alloc(64 * 1024);
    const chunks = [];
    let total = 0;
    for (; ; ) {
      const length = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (length === 0) break;
      total += length;
      if (total > messageLimit) {
        fail(
          "directory_authority_request_too_large",
          "The directory operation input exceeds the bridge byte limit."
        );
      }
      chunks.push(Buffer.from(chunk.subarray(0, length)));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  function reportFailure(error) {
    const detail = error;
    const code = typeof detail?.code === "string" ? detail.code.slice(0, 256) : "directory_authority_failed";
    const message = typeof detail?.message === "string" ? detail.message.slice(0, 4096) : "The directory operation failed.";
    let encoded;
    try {
      encoded = JSON.stringify({
        ok: false,
        error: { code, message, data: detail?.data }
      });
      if (Buffer.byteLength(encoded) > messageLimit) throw new Error();
    } catch {
      encoded = JSON.stringify({ ok: false, error: { code, message } });
    }
    writeResponse(mode === "task" ? 1 : 2, encoded);
    process.exitCode = mode === "task" ? 0 : 125;
  }
  function writeResponse(fd, encoded) {
    const bytes = Buffer.from(encoded);
    let offset = 0;
    while (offset < bytes.length) {
      offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
    }
  }
  async function runTask(input) {
    if (!task)
      fail("directory_authority_failed", "The directory task is missing.");
    const result = await task(input);
    const encoded = JSON.stringify({ ok: true, result });
    if (Buffer.byteLength(encoded) > messageLimit) {
      fail(
        "directory_authority_result_too_large",
        "The directory operation result exceeds the bridge byte limit."
      );
    }
    writeResponse(1, encoded);
  }
  function runCommand(input) {
    const { spawn: spawn4 } = require("node:child_process");
    const command = input;
    const child = spawn4(command.command, command.args, {
      stdio: ["ignore", "inherit", "inherit"],
      env: process.env
    });
    child.once("error", reportFailure);
    child.once("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      if (typeof code === "number") process.exitCode = code;
    });
  }
  try {
    verifyDirectoryAuthority();
    const input = readRequest();
    if (mode === "command") {
      runCommand(input);
      return;
    }
    void runTask(input).catch(reportFailure);
  } catch (error) {
    reportFailure(error);
  }
}
function directoryAuthorityScript(mode, messageLimit, task) {
  const taskSource = task ? `(${task.toString()})` : "undefined";
  const preserveFunctionName = "const __name=(target,value)=>Object.defineProperty(target,'name',{value,configurable:true});";
  return `${preserveFunctionName}(${directoryAuthorityBootstrap.toString()})(${JSON.stringify(mode)},${messageLimit},${taskSource});`;
}

// src/shared/directory-authority/protocol.ts
var import_node_path3 = require("node:path");

// src/shared/directory-authority/errors.ts
var DirectoryAuthorityError = class extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
    this.name = "DirectoryAuthorityError";
  }
  code;
  data;
};

// src/shared/directory-authority/protocol.ts
var AUTHORITY_MESSAGE_LIMIT = 8 * 1024 * 1024;
var AUTHORITY_STDERR_LIMIT = 16 * 1024;
function assertDirectoryAuthorityLocation(location) {
  if (!(0, import_node_path3.isAbsolute)(location.directoryPath)) {
    throw new DirectoryAuthorityError(
      "directory_authority_invalid_path",
      "The directory authority requires an absolute starting path."
    );
  }
  const hasOpenDescriptorNumber = Number.isInteger(location.directoryFd) && location.directoryFd >= 0;
  if (hasOpenDescriptorNumber) return;
  throw new DirectoryAuthorityError(
    "directory_authority_invalid_fd",
    "The directory authority requires an open directory descriptor."
  );
}
function authorityEnvironment(environment = process.env) {
  const sanitized = { ...environment };
  delete sanitized.NODE_OPTIONS;
  delete sanitized.NODE_PATH;
  return sanitized;
}
function encodeAuthorityRequest(input) {
  let encoded;
  try {
    encoded = JSON.stringify(input);
  } catch {
    throw new DirectoryAuthorityError(
      "directory_authority_invalid_request",
      "The directory operation input must be JSON serializable."
    );
  }
  if (encoded === void 0) {
    throw new DirectoryAuthorityError(
      "directory_authority_invalid_request",
      "The directory operation input must be JSON serializable."
    );
  }
  if (Buffer.byteLength(encoded) <= AUTHORITY_MESSAGE_LIMIT) return encoded;
  throw new DirectoryAuthorityError(
    "directory_authority_request_too_large",
    "The directory operation input exceeds the bridge byte limit."
  );
}

// src/shared/directory-authority/command.ts
function spawnDirectoryAuthorityCommand(input) {
  assertDirectoryAuthorityLocation(input);
  const request = encodeAuthorityRequest({
    command: input.command,
    args: input.args
  });
  const child = (0, import_node_child_process.spawn)(
    process.execPath,
    [
      "--input-type=commonjs",
      "-e",
      directoryAuthorityScript("command", AUTHORITY_MESSAGE_LIMIT)
    ],
    {
      cwd: input.directoryPath,
      env: authorityEnvironment(input.env),
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", input.directoryFd, "pipe"]
    }
  );
  const requestPipe = child.stdio[4];
  requestPipe?.on("error", () => void 0);
  requestPipe?.end(request);
  return child;
}

// plugins/local-search/source/windows-search-process.ts
var import_node_child_process2 = require("node:child_process");
var import_node_path4 = require("node:path");

// src/shared/windows-job-object.ts
var WINDOWS_EXEC_JOB_SOURCE = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class AbotExecJob {
  private static IntPtr job = IntPtr.Zero;

  [StructLayout(LayoutKind.Sequential)]
  private struct BasicLimits {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct IoCounters {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct ExtendedLimits {
    public BasicLimits BasicLimitInformation;
    public IoCounters IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetInformationJobObject(IntPtr handle, int kind,
    ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool AssignProcessToJobObject(IntPtr handle, IntPtr process);
  [DllImport("kernel32.dll")]
  private static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);

  public static void Attach() {
    if (job != IntPtr.Zero) throw new InvalidOperationException("Already attached");
    IntPtr candidate = CreateJobObject(IntPtr.Zero, null);
    if (candidate == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      ExtendedLimits limits = new ExtendedLimits();
      limits.BasicLimitInformation.LimitFlags = 0x00002000; // KILL_ON_JOB_CLOSE
      if (!SetInformationJobObject(candidate, 9, ref limits,
          (uint)Marshal.SizeOf(typeof(ExtendedLimits))))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      if (!AssignProcessToJobObject(candidate, GetCurrentProcess()))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      job = candidate;
      candidate = IntPtr.Zero;
    } finally {
      if (candidate != IntPtr.Zero) CloseHandle(candidate);
    }
  }
}
`;

// plugins/local-search/source/windows-search-script.ts
init_native_script();
init_authority_script();

// plugins/local-search/source/windows-search-lease.ts
var WINDOWS_SEARCH_LEASE = String.raw`
public static partial class AbotFilesystem {
  sealed class SearchPathLease : IDisposable {
    readonly List<SafeFileHandle> held = new List<SafeFileHandle>();
    public readonly string Target;
    public readonly bool IsFile;
    public SearchPathLease(Dictionary<string,object> request) {
      try {
        Target = Path.GetFullPath(Text(request, "targetPath"));
        string root = Path.GetFullPath(Text(request, "rootPath")).TrimEnd('\\');
        if (!String.Equals(Target.TrimEnd('\\'), root, StringComparison.OrdinalIgnoreCase) &&
            !Target.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase))
          throw new FsFault("filesystem_invalid_path");
        IsFile = (bool)request["isFile"];
        string current = Path.GetPathRoot(Target);
        var handle = OpenHandle(null, NativePath(current), true, 1, 0x80000000, 3);
        held.Add(handle);
        bool foundRoot = VerifyRoot(current, root, handle, request);
        string rest = Target.Substring(current.Length).TrimEnd('\\');
        string[] parts = rest.Length == 0 ? new string[0] : rest.Split('\\');
        for (int i = 0; i < parts.Length; i++) {
          ValidateComponent(parts[i]);
          bool isFile = IsFile && i == parts.Length - 1;
          handle = OpenHandle(handle, parts[i], !isFile, 1, 0x80000000, isFile ? 1u : 3u);
          held.Add(handle);
          current = Path.Combine(current, parts[i]);
          if (!String.Equals(FinalPath(handle).TrimEnd('\\'), current.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
            throw new FsFault("filesystem_path_changed");
          foundRoot |= VerifyRoot(current, root, handle, request);
        }
        if (!foundRoot || !MatchesIdentity(Identity(handle), request["targetIdentity"] as Dictionary<string,object>))
          throw new FsFault("filesystem_path_changed");
      } catch { Dispose(); throw; }
    }
    static bool VerifyRoot(string current, string root, SafeFileHandle handle, Dictionary<string,object> request) {
      if (!String.Equals(current.TrimEnd('\\'), root, StringComparison.OrdinalIgnoreCase)) return false;
      var expected = request["rootIdentity"] as Dictionary<string,object>;
      if (expected == null || !MatchesIdentity(Identity(handle), expected)) throw new FsFault("filesystem_path_changed");
      return true;
    }
    public void Dispose() {
      for (int i = held.Count - 1; i >= 0; i--) held[i].Dispose();
      held.Clear();
    }
  }
}
`;

// plugins/local-search/source/windows-search-script.ts
var SEARCH_COMMAND = String.raw`
public static partial class AbotFilesystem {
  static string QuoteSearchArgument(string value) {
    var quoted = new StringBuilder("\"");
    int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { quoted.Append('\\', slashes * 2 + 1); quoted.Append(c); slashes = 0; continue; }
      quoted.Append('\\', slashes); slashes = 0; quoted.Append(c);
    }
    quoted.Append('\\', slashes * 2); quoted.Append('"');
    return quoted.ToString();
  }
  public static int Search(string input) {
    var json = new JavaScriptSerializer { MaxJsonLength = 2 * 1024 * 1024 };
    try {
      var request = json.Deserialize<Dictionary<string,object>>(input);
      using (var lease = new SearchPathLease(request)) {
        var args = (System.Collections.IEnumerable)request["args"];
        var quoted = new List<string>();
        foreach (object arg in args) quoted.Add(QuoteSearchArgument((string)arg));
        var start = new System.Diagnostics.ProcessStartInfo {
          FileName = Text(request, "command"), Arguments = String.Join(" ", quoted),
          WorkingDirectory = lease.IsFile ? Path.GetDirectoryName(lease.Target) : lease.Target,
          UseShellExecute = false, CreateNoWindow = true,
          RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
        };
        using (var process = System.Diagnostics.Process.Start(start)) {
          process.StandardInput.Close();
          var output = process.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
          var errors = process.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
          process.WaitForExit();
          System.Threading.Tasks.Task.WaitAll(output, errors);
          return process.ExitCode;
        }
      }
    } catch { return 125; }
  }
}
`;
var WINDOWS_SEARCH_SOURCE = [
  WINDOWS_FILESYSTEM_NATIVE,
  WINDOWS_FILESYSTEM_AUTHORITY,
  WINDOWS_SEARCH_LEASE,
  SEARCH_COMMAND
].join("\n");

// plugins/local-search/source/windows-search-process.ts
var BOOTSTRAP = [
  "$ErrorActionPreference='Stop'",
  "$ProgressPreference='SilentlyContinue'",
  "if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { exit 126 }",
  "$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')",
  "try {",
  "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)",
  "$envelope=[Console]::In.ReadToEnd() | ConvertFrom-Json",
  "Add-Type -TypeDefinition $envelope.jobSource",
  "[AbotExecJob]::Attach()",
  "Add-Type -ReferencedAssemblies @('System.Web.Extensions') -TypeDefinition $envelope.source",
  "$result=[AbotFilesystem]::Search($envelope.request)",
  "exit $result",
  "} catch { exit 126 }"
].join(";\n");
function windowsSearchUnavailable() {
  return new LocalSearchError(
    "local_search_windows_unavailable",
    "The Windows local-search helper is unavailable or blocked by computer policy. No results were returned. Do not retry or bypass this restriction with another tool; ask the user to check PowerShell/C# availability or contact their administrator."
  );
}
function windowsSearchExitFailure(code) {
  if (code === 125) return windowsSearchAuthorityUnavailable();
  const helperUnavailable = code === 126 || code === void 0;
  if (helperUnavailable) return windowsSearchUnavailable();
  return new LocalSearchError(
    "local_search_failed",
    "Local search could not complete under the selected logical root."
  );
}
function spawnWindowsSearch(params) {
  const input = JSON.stringify({
    source: WINDOWS_SEARCH_SOURCE,
    jobSource: WINDOWS_EXEC_JOB_SOURCE,
    request: JSON.stringify({
      ...params.authority,
      command: params.command,
      args: params.args
    })
  });
  if (Buffer.byteLength(input) > 2 * 1024 * 1024)
    throw windowsSearchUnavailable();
  const executable = (0, import_node_path4.join)(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const child = (0, import_node_child_process2.spawn)(
    executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", BOOTSTRAP],
    {
      env: params.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    }
  );
  child.stdin.on("error", () => void 0);
  child.stdin.end(input, "utf8");
  return {
    child,
    terminate: () => {
      child.kill("SIGKILL");
    },
    failureForExit: windowsSearchExitFailure
  };
}

// plugins/local-search/source/ripgrep-process.ts
function isWindowsSearchAuthority(authority) {
  return authority !== void 0 && "platform" in authority;
}
function controlledRipgrepEnvironment() {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.toUpperCase() === "RIPGREP_CONFIG_PATH") {
      delete environment[name];
    }
  }
  return environment;
}
function terminateAuthorityGroup(child) {
  if (!child.pid) {
    child.kill("SIGKILL");
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    const groupAlreadyExited = error.code === "ESRCH";
    if (groupAlreadyExited) return;
    throw error;
  }
}
function spawnRipgrepProcess(args, cwd, stdinFd, directoryAuthority) {
  const commandArgs = ["--no-config", ...args];
  const env = controlledRipgrepEnvironment();
  if (isWindowsSearchAuthority(directoryAuthority)) {
    return spawnWindowsSearch({
      authority: directoryAuthority,
      command: import_ripgrep.rgPath,
      args: commandArgs,
      env
    });
  }
  if (directoryAuthority) {
    const child2 = spawnDirectoryAuthorityCommand({
      ...directoryAuthority,
      command: import_ripgrep.rgPath,
      args: commandArgs,
      env
    });
    return { child: child2, terminate: () => terminateAuthorityGroup(child2) };
  }
  const child = (0, import_node_child_process3.spawn)(import_ripgrep.rgPath, commandArgs, {
    cwd,
    env,
    stdio: [stdinFd ?? "ignore", "pipe", "pipe"],
    windowsHide: true
  });
  return {
    child,
    terminate: () => {
      child.kill("SIGKILL");
    }
  };
}

// plugins/local-search/source/ripgrep.ts
var SEARCH_TIMEOUT_MS = 1e4;
var MAX_PATH_RECORD_BYTES = 64 * 1024;
var MAX_JSON_RECORD_BYTES = 512 * 1024;
var IGNORED_GLOBS = Object.freeze([
  "!.git/**",
  "!node_modules/**",
  "!dist/**",
  "!coverage/**",
  "!.runtime/**"
]);
function rgGlobArgs() {
  return Object.freeze(IGNORED_GLOBS.flatMap((glob) => ["--glob", glob]));
}
function escapeRgGlobLiteral(value) {
  return [...value].map(
    (character) => "\\*?[]{}!".includes(character) ? `\\${character}` : character
  ).join("");
}
function decodeUtf8Record(bytes, kind) {
  let value;
  try {
    value = new import_node_util.TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new LocalSearchError(
      "local_search_result_encoding_unsupported",
      `Local search found ${kind === "path" ? "a path" : "text"} with unsupported encoding.`
    );
  }
  return value;
}
function createDelimitedParser(params) {
  let pending = Buffer.alloc(0);
  const parseAvailable = (chunk, includeTrailing, accept) => {
    const combined = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
    let start = 0;
    for (; ; ) {
      const end = combined.indexOf(params.delimiter, start);
      if (end < 0) break;
      if (end - start > params.maxRecordBytes) {
        throw new LocalSearchError(
          "local_search_result_invalid",
          "Local search returned an oversized result record."
        );
      }
      const parsed = params.parse(combined.subarray(start, end));
      if (parsed !== void 0 && !accept(parsed)) {
        pending = Buffer.alloc(0);
        return;
      }
      start = end + 1;
    }
    const trailing = combined.subarray(start);
    if (trailing.length > params.maxRecordBytes) {
      throw new LocalSearchError(
        "local_search_result_invalid",
        "Local search returned an oversized result record."
      );
    }
    pending = Buffer.from(trailing);
    if (includeTrailing && pending.length > 0) {
      const parsed = params.parse(pending);
      pending = Buffer.alloc(0);
      if (parsed !== void 0) accept(parsed);
    }
  };
  return Object.freeze({
    push: (chunk, accept) => parseAvailable(chunk, false, accept),
    finish: (accept) => parseAvailable(Buffer.alloc(0), true, accept)
  });
}
async function runRipgrepBounded(args, cwd, maxResults, parser, signal, stdinFd, directoryAuthority) {
  if (signal?.aborted) {
    throw new LocalSearchError(
      "local_search_failed",
      "Local search could not complete under the selected logical root."
    );
  }
  return new Promise((resolve, reject) => {
    const items = [];
    let completed = false;
    let stoppedAfterExtraResult = false;
    let timedOut = false;
    let aborted = false;
    let parserError;
    const { child, terminate, failureForExit } = spawnRipgrepProcess(
      args,
      cwd,
      stdinFd,
      directoryAuthority
    );
    const cleanup = () => {
      clearTimeout(timeout);
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
    };
    const settleFailure = (error) => {
      if (completed) return;
      completed = true;
      cleanup();
      reject(
        error instanceof LocalSearchError ? error : new LocalSearchError(
          "local_search_failed",
          "Local search could not complete under the selected logical root."
        )
      );
    };
    const accept = (value, mayStopProcess) => {
      if (items.length < maxResults) {
        items.push(value);
        return true;
      }
      stoppedAfterExtraResult = true;
      if (mayStopProcess) {
        child.stdout.pause();
        terminate();
      }
      return false;
    };
    const abortListener = () => {
      aborted = true;
      terminate();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, SEARCH_TIMEOUT_MS);
    timeout.unref?.();
    child.stdout.on("data", (chunk) => {
      if (completed || stoppedAfterExtraResult || parserError) return;
      try {
        parser.push(chunk, (value) => accept(value, true));
      } catch (error) {
        parserError = error;
        child.stdout.pause();
        terminate();
      }
    });
    child.stderr.on("data", () => void 0);
    child.on("error", (error) => settleFailure(failureForExit?.(void 0) ?? error));
    child.on("close", (code) => {
      if (completed) return;
      if (parserError) {
        settleFailure(parserError);
        return;
      }
      if (timedOut || aborted) {
        settleFailure();
        return;
      }
      if (!stoppedAfterExtraResult) {
        try {
          parser.finish((value) => accept(value, false));
        } catch (error) {
          settleFailure(error);
          return;
        }
      }
      if (!stoppedAfterExtraResult && code !== 0 && code !== 1) {
        settleFailure(failureForExit?.(code));
        return;
      }
      completed = true;
      cleanup();
      resolve(
        Object.freeze({
          items: Object.freeze(items),
          truncated: stoppedAfterExtraResult
        })
      );
    });
    if (signal) {
      if (signal.aborted) abortListener();
      else signal.addEventListener("abort", abortListener, { once: true });
    }
  });
}
function requiredJsonText(value) {
  if (!value || typeof value !== "object") {
    throw new LocalSearchError(
      "local_search_result_invalid",
      "Local search returned invalid data."
    );
  }
  const record = value;
  if (typeof record.text !== "string") {
    if ("bytes" in record) {
      throw new LocalSearchError(
        "local_search_result_encoding_unsupported",
        "Local search found text with unsupported encoding."
      );
    }
    throw new LocalSearchError(
      "local_search_result_invalid",
      "Local search returned invalid data."
    );
  }
  return record.text;
}
function parseJsonContentEvent(line) {
  if (!line) return void 0;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    throw new LocalSearchError(
      "local_search_result_invalid",
      "Local search returned invalid data."
    );
  }
  if (!event || typeof event !== "object") return void 0;
  const eventRecord = event;
  if (eventRecord.type !== "match") return void 0;
  const data = eventRecord.data;
  if (!data || typeof data !== "object") {
    throw new LocalSearchError(
      "local_search_result_invalid",
      "Local search returned invalid data."
    );
  }
  const dataRecord = data;
  if (!Number.isSafeInteger(dataRecord.line_number) || Number(dataRecord.line_number) < 1) {
    throw new LocalSearchError(
      "local_search_result_invalid",
      "Local search returned invalid data."
    );
  }
  const text = requiredJsonText(dataRecord.lines);
  return Object.freeze({
    path: requiredJsonText(dataRecord.path),
    lineNumber: Number(dataRecord.line_number),
    text: text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text
  });
}
function runRipgrepPathSearch(args, cwd, maxResults, signal, directoryAuthority) {
  return runRipgrepBounded(
    args,
    cwd,
    maxResults,
    createDelimitedParser({
      delimiter: 0,
      maxRecordBytes: MAX_PATH_RECORD_BYTES,
      parse: (record) => decodeUtf8Record(record, "path")
    }),
    signal,
    void 0,
    directoryAuthority
  );
}
function runRipgrepContentSearch(args, cwd, maxResults, signal, stdinFd, directoryAuthority) {
  return runRipgrepBounded(
    args,
    cwd,
    maxResults,
    createDelimitedParser({
      delimiter: 10,
      maxRecordBytes: MAX_JSON_RECORD_BYTES,
      parse: (record) => {
        const normalized = record.at(-1) === 13 ? record.subarray(0, -1) : record;
        return parseJsonContentEvent(decodeUtf8Record(normalized, "result"));
      }
    }),
    signal,
    stdinFd,
    directoryAuthority
  );
}

// plugins/local-search/source/index.ts
var DEFAULT_MAX_RESULTS = 40;
var MAX_RESULTS = 200;
function fileNameMatches(logicalPath, query, caseSensitive) {
  const filename = import_node_path5.posix.basename(logicalPath);
  return caseSensitive ? filename.includes(query) : filename.toLowerCase().includes(query.toLowerCase());
}
var index_default = defineRuntimePlugin((context) => ({
  handlers: {
    async local_search(params, executionContext = void 0) {
      let root;
      const pathContext = {
        ...context,
        runtimePathResolver: executionContext?.runtimePathResolver ?? context.runtimePathResolver
      };
      try {
        const query = readRequiredString(params.query, {
          name: "query",
          maxLength: 1024
        });
        const rawMode = readOptionalString(params.mode) ?? "both";
        if (!["names", "content", "both"].includes(rawMode)) {
          return failureResult({
            errorCode: "plugin_parameter_invalid",
            message: "mode must be names, content, or both."
          });
        }
        const mode = rawMode;
        const caseSensitive = readBoolean(params.case_sensitive, {
          defaultValue: false
        });
        const maxResults = readBoundedInteger(params.max_results, {
          defaultValue: DEFAULT_MAX_RESULTS,
          minimum: 1,
          maximum: MAX_RESULTS,
          name: "max_results"
        });
        root = await resolveSearchRoot(pathContext, params.path);
        const candidates = [];
        let sourceTruncated = false;
        if (mode === "names" || mode === "both") {
          const names = root.isFile ? Object.freeze({
            items: Object.freeze(
              fileNameMatches(root.target.logicalPath, query, caseSensitive) ? [import_node_path5.posix.basename(root.target.logicalPath)] : []
            ),
            truncated: false
          }) : await runRipgrepPathSearch(
            [
              "--files",
              "--null",
              "--hidden",
              ...rgGlobArgs(),
              caseSensitive ? "--glob" : "--iglob",
              `*${escapeRgGlobLiteral(query)}*`,
              "--",
              root.commandTarget
            ],
            root.commandDirectory,
            maxResults,
            executionContext?.abortSignal,
            root.directoryAuthority
          );
          sourceTruncated ||= names.truncated;
          for (const rawPath of names.items) {
            candidates.push({
              kind: "name",
              value: qualifyMatchPath(pathContext, root, rawPath)
            });
          }
        }
        if ((mode === "content" || mode === "both") && !sourceTruncated) {
          const remaining = maxResults - candidates.length;
          const content = await runRipgrepContentSearch(
            [
              "--json",
              "--with-filename",
              "--fixed-strings",
              "--line-number",
              "--no-heading",
              "--color",
              "never",
              "--max-columns",
              "2048",
              "--max-columns-preview",
              "--hidden",
              ...caseSensitive ? [] : ["--ignore-case"],
              ...rgGlobArgs(),
              "--",
              query,
              root.commandTarget
            ],
            root.commandDirectory,
            remaining,
            executionContext?.abortSignal,
            root.stdinFd,
            root.directoryAuthority
          );
          sourceTruncated ||= content.truncated;
          for (const match of content.items) {
            candidates.push({
              kind: "content",
              value: {
                ...match,
                path: qualifyMatchPath(pathContext, root, match.path)
              }
            });
          }
        }
        const buildResult = (bounded2) => successResult({
          output: bounded2.output,
          producedNewInformation: true,
          actions: [
            {
              type: "inspect_target",
              target: root.target.logicalPath,
              details: "local_search"
            }
          ],
          data: {
            hasData: bounded2.entries.length > 0,
            itemCount: bounded2.entries.length,
            mode,
            logicalRoot: root.target.logicalPath,
            truncation: bounded2.metadata,
            observationMeta: {
              kind: "volatile_external",
              carryPolicy: "never"
            }
          }
        });
        const bounded = budgetSearchOutput(
          query,
          mode,
          candidates,
          sourceTruncated,
          (candidate) => buildResult(candidate).ok === true
        );
        return buildResult(bounded);
      } catch (error) {
        if (isLocalSearchError(error)) {
          return failureResult({
            errorCode: error.code,
            message: error.message
          });
        }
        return failureFromError(error, {
          fallbackCode: "local_search_failed",
          fallbackMessage: "Local search failed.",
          operation: "local_search"
        });
      } finally {
        await root?.close().catch(() => void 0);
      }
    }
  }
}));
