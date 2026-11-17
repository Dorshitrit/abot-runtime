// GENERATED FILE - DO NOT EDIT.
// Source: plugins/filesystem-ea/source/index.ts
// Run "npm run build:plugins" after editing plugin source.
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/shared/windows-file-io/read-bytes-script.ts
var WINDOWS_FILE_READ_BYTES;
var init_read_bytes_script = __esm({
  "src/shared/windows-file-io/read-bytes-script.ts"() {
    "use strict";
    WINDOWS_FILE_READ_BYTES = String.raw`
public static partial class AbotFilesystem {
  static byte[] ReadBytes(SafeFileHandle file, long position, int length) {
    long actual; Check(SetFilePointerEx(file, position, out actual, 0));
    if (actual != position) throw new FsFault("filesystem_read_incomplete");
    var bytes = new byte[length];
    int offset = 0;
    while (offset < length) {
      var chunk = new byte[Math.Min(65536, length-offset)];
      uint read; Check(ReadFile(file, chunk, (uint)chunk.Length, out read, IntPtr.Zero));
      if (read == 0 || read > chunk.Length) throw new FsFault("filesystem_read_incomplete");
      Buffer.BlockCopy(chunk, 0, bytes, offset, (int)read);
      offset += (int)read;
    }
    return bytes;
  }
}
`;
  }
});

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

// plugins/filesystem-ea/source/index.ts
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

// src/plugin-sdk/paths.ts
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

// plugins/filesystem/source/errors.ts
var FilesystemToolError = class extends Error {
  code;
  data;
  constructor(code, message = code, data) {
    super(message);
    this.name = "FilesystemToolError";
    this.code = code;
    this.data = data;
  }
};
function fail(code, message = code, data) {
  throw new FilesystemToolError(code, message, data);
}
function isNodeErrorCode(error, code) {
  return error instanceof Error && typeof error.code === "string" && error.code === code;
}
function isDirectoryTypeFailure(code) {
  return code === "not_a_directory" || code === "ENOTDIR";
}
function failNotDirectory() {
  fail(
    "not_a_directory",
    "A component of the requested path is not a directory. An existing file cannot contain child files. Inspect the path and choose a file target under a directory; do not repeat the same operation unchanged or overwrite the blocking file to turn it into a directory."
  );
}
function rethrowFilesystemError(error, operation, logicalPath) {
  if (isRuntimeToolPathError(error) || error instanceof FilesystemToolError) {
    throw error;
  }
  if (isNodeErrorCode(error, "ENOENT")) {
    fail("file_not_found", `Path does not exist: ${logicalPath}`);
  }
  if (error instanceof Error && isDirectoryTypeFailure(error.code)) {
    failNotDirectory();
  }
  if (isNodeErrorCode(error, "EACCES") || isNodeErrorCode(error, "EPERM")) {
    fail(
      "filesystem_access_denied",
      `Access was denied while attempting to ${operation}: ${logicalPath}`
    );
  }
  if (isNodeErrorCode(error, "EISDIR")) {
    fail("not_a_file", `Expected a regular file: ${logicalPath}`);
  }
  fail(
    `filesystem_${operation}_failed`,
    `Filesystem ${operation} failed for ${logicalPath}.`
  );
}

// plugins/filesystem/source/path-service.ts
var import_node_path = require("node:path");
var FILESYSTEM_LOCATIONS = Object.freeze([
  "agent_work",
  "workspace"
]);
function resolverFor(fallback, context) {
  return context?.runtimePathResolver ?? fallback;
}
function resolveWith(resolver, rawPath) {
  return resolver.resolve(rawPath, {
    requirePath: true,
    allowedLocations: FILESYSTEM_LOCATIONS
  });
}
function logicalParent(logicalPath) {
  if (logicalPath === "." || logicalPath === "workspace") {
    return logicalPath;
  }
  return import_node_path.posix.dirname(logicalPath);
}
function createFilesystemPathService(fallbackResolver) {
  return Object.freeze({
    resolve(rawPath, context) {
      return resolveWith(resolverFor(fallbackResolver, context), rawPath);
    },
    parent(target, context) {
      return resolveWith(
        resolverFor(fallbackResolver, context),
        logicalParent(target.logicalPath)
      );
    },
    sibling(target, name, context) {
      const parent = logicalParent(target.logicalPath);
      const logicalPath = parent === "." ? name : import_node_path.posix.join(parent, name);
      return resolveWith(resolverFor(fallbackResolver, context), logicalPath);
    }
  });
}

// plugins/filesystem/source/mutation-coordinator.ts
function createFilesystemMutationCoordinator() {
  const tails = /* @__PURE__ */ new Map();
  return Object.freeze({
    async runExclusive(targetKey, task) {
      if (process.platform === "win32") targetKey = targetKey.toUpperCase();
      const previous = tails.get(targetKey) ?? Promise.resolve();
      let release;
      const current = new Promise((resolve) => {
        release = resolve;
      });
      tails.set(targetKey, current);
      await previous;
      try {
        return await task();
      } finally {
        release();
        if (tails.get(targetKey) === current) tails.delete(targetKey);
      }
    }
  });
}
var COORDINATOR_KEY = /* @__PURE__ */ Symbol.for("abot.filesystem.mutation-coordinator.v1");
var processState = globalThis;
function getProcessFilesystemMutationCoordinator() {
  return processState[COORDINATOR_KEY] ??= createFilesystemMutationCoordinator();
}

// plugins/filesystem/source/windows/request-availability.ts
var import_node_async_hooks = require("node:async_hooks");

// plugins/filesystem/source/windows/process.ts
var import_node_child_process = require("node:child_process");
var import_node_path2 = require("node:path");

// plugins/filesystem/source/windows/source.ts
init_read_bytes_script();

// plugins/filesystem/source/windows/native-script.ts
init_native_script();

// plugins/filesystem/source/windows/authority-script.ts
init_authority_script();

// plugins/filesystem/source/windows/read-script.ts
var WINDOWS_FILESYSTEM_READ = String.raw`
public static partial class AbotFilesystem {
  static object ReadSlices(Dictionary<string,object> request) {
    int headLimit=Limit(request, "headBytes", 1048576), tailLimit=Limit(request, "tailBytes", 1048576);
    int maximum=Limit(request, "maximumFileBytes", 1048576);
    string[] parts=Components(request);
    if (parts.Length == 0) throw new FsFault("not_a_file");
    using (var chain=new DirectoryChain(request)) {
      chain.Walk(parts, parts.Length-1, false);
      using (var file=OpenHandle(chain.Current, parts[parts.Length-1], false, 1, 0x80000000, 1)) {
        var before=Metadata(file);
        long size=Convert.ToInt64(before["size"]);
        if (maximum > 0 && size > maximum) throw new FsFault("file_too_large");
        bool complete=size <= (long)headLimit+tailLimit;
        var head=ReadBytes(file, 0, complete ? (int)size : headLimit);
        var tail=complete ? new byte[0] : ReadBytes(file, size-tailLimit, tailLimit);
        if (!SameMetadata(before, Metadata(file))) throw new FsFault("filesystem_read_changed");
        return Record("metadata", before, "head", Convert.ToBase64String(head), "tail", Convert.ToBase64String(tail));
      }
    }
  }
  static object SampleDirectory(Dictionary<string,object> request) {
    int maximum=Limit(request, "maxEntries", 160);
    string[] parts=Components(request);
    using (var chain=new DirectoryChain(request)) {
      chain.Walk(parts, parts.Length, false);
      var before=Basic(chain.Current);
      var entries=new List<string>();
      bool truncated=false, complete=false;
      IntPtr buffer=Marshal.AllocHGlobal(16384);
      try {
        int kind=11;
        while (!complete) {
          if (!GetFileInformationByHandleEx(chain.Current, kind, buffer, 16384)) {
            uint error=(uint)Marshal.GetLastWin32Error();
            if (error == 18) break;
            NativeFailure(error);
          }
          kind=10;
          int offset=0;
          for (;;) {
            int next=Marshal.ReadInt32(buffer, offset), attributes=Marshal.ReadInt32(buffer, offset+56);
            int nameLength=Marshal.ReadInt32(buffer, offset+60);
            if (nameLength < 0 || nameLength % 2 != 0 || offset+104+nameLength > 16384)
              throw new FsFault("filesystem_native_operation_failed");
            string name=Marshal.PtrToStringUni(IntPtr.Add(buffer, offset+104), nameLength/2);
            if (name != "." && name != "..") {
              if (entries.Count == maximum) { truncated=true; complete=true; break; }
              entries.Add(name + ((attributes & 0x410) == 0x10 ? "/" : ""));
            }
            if (next == 0) break;
            if (next < 104 || offset+next >= 16384) throw new FsFault("filesystem_native_operation_failed");
            offset+=next;
          }
        }
      } finally { Marshal.FreeHGlobal(buffer); }
      var after=Basic(chain.Current);
      if (before.Modified != after.Modified || before.Changed != after.Changed) throw new FsFault("filesystem_read_changed");
      return Record("entries", entries, "truncated", truncated);
    }
  }
}
`;

// plugins/filesystem/source/windows/streams-script.ts
var WINDOWS_FILESYSTEM_STREAMS = String.raw`
public static partial class AbotFilesystem {
  static void RequireUnnamedDataStreamOnly(SafeFileHandle file) {
    // One unnamed data stream fits in 40 bytes. Extra entries/names must not
    // be silently discarded by replacement; only a bounded header is needed.
    const int capacity=64;
    IntPtr buffer=Marshal.AllocHGlobal(capacity);
    try {
      if (!GetFileInformationByHandleEx(file, 7, buffer, capacity)) {
        uint error=(uint)Marshal.GetLastWin32Error();
        if (error == 122 || error == 234)
          throw new FsFault("filesystem_named_streams_unsupported");
        NativeFailure(error);
      }
      int next=Marshal.ReadInt32(buffer, 0), length=Marshal.ReadInt32(buffer, 4);
      if (next != 0 || length != 14)
        throw new FsFault("filesystem_named_streams_unsupported");
      string name=Marshal.PtrToStringUni(IntPtr.Add(buffer, 24), length/2);
      if (name != "::$DATA") throw new FsFault("filesystem_named_streams_unsupported");
    } finally { Marshal.FreeHGlobal(buffer); }
  }
}
`;

// plugins/filesystem/source/windows/storage-script.ts
var WINDOWS_FILESYSTEM_STORAGE = String.raw`
public static partial class AbotFilesystem {
  static void RequireReplaceableStorage(SafeFileHandle file) {
    const uint encrypted=0x4000, compressed=0x800;
    if ((Basic(file).Attributes & (encrypted | compressed)) != 0)
      throw new FsFault("filesystem_storage_attributes_unsupported");
    RequireUnnamedDataStreamOnly(file);
  }
}
`;

// plugins/filesystem/source/windows/publication-script.ts
var WINDOWS_FILESYSTEM_PUBLICATION = String.raw`
public static partial class AbotFilesystem {
  static void CheckLinkPublication(int status) {
    if (status >= 0) return;
    uint error=RtlNtStatusToDosError(status);
    if (error == 1 || error == 50 || error == 87)
      throw new FsFault("filesystem_windows_publication_unsupported");
    NativeFailure(error);
  }
  static void PublishLinkRelative(SafeFileHandle file, SafeFileHandle parent, string name, bool replace) {
    byte[] bytes=Encoding.Unicode.GetBytes(name);
    int rootOffset=IntPtr.Size == 8 ? 8 : 4;
    int lengthOffset=rootOffset+IntPtr.Size, nameOffset=lengthOffset+4;
    IntPtr buffer=Marshal.AllocHGlobal(nameOffset+bytes.Length);
    try {
      for (int i=0;i<nameOffset;i++) Marshal.WriteByte(buffer, i, 0);
      // FileLinkInformationEx: replace the destination atomically, retaining
      // existing observations. Closing this handle deletes only its temporary name.
      Marshal.WriteInt32(buffer, 0, replace ? 3 : 0);
      Marshal.WriteIntPtr(buffer, rootOffset, parent.DangerousGetHandle());
      Marshal.WriteInt32(buffer, lengthOffset, bytes.Length);
      Marshal.Copy(bytes, 0, IntPtr.Add(buffer, nameOffset), bytes.Length);
      IoStatus status;
      CheckLinkPublication(NtSetInformationFile(file, out status, buffer, (uint)(nameOffset+bytes.Length), 72));
    } finally { Marshal.FreeHGlobal(buffer); }
  }
}
`;

// plugins/filesystem/source/windows/write-script.ts
var WINDOWS_FILESYSTEM_WRITE = String.raw`
public static partial class AbotFilesystem {
  static string Digest(byte[] bytes) {
    using (var hash=System.Security.Cryptography.SHA256.Create())
      return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
  }
  static SafeFileHandle ObserveExisting(SafeFileHandle parent, string name, Dictionary<string,object> expected) {
    SafeFileHandle file=null;
    try {
      try { file=OpenHandle(parent, name, false, 1, 0x80020000, 7); }
      catch (FsFault error) {
        if (error.Code != "file_not_found") throw;
        if (Text(expected, "kind") != "absent") throw new FsFault("filesystem_target_changed");
        return null;
      }
      if (Text(expected, "kind") != "file") throw new FsFault("filesystem_target_changed");
      var before=Metadata(file);
      if (!SameMetadata(before, expected)) throw new FsFault("filesystem_target_changed");
      long size=Convert.ToInt64(before["size"]);
      if (size > 1048576) throw new FsFault("filesystem_target_changed");
      byte[] bytes=ReadBytes(file, 0, (int)size);
      if (!SameMetadata(before, Metadata(file)) || Digest(bytes) != Text(expected, "digest"))
        throw new FsFault("filesystem_target_changed");
      RequireReplaceableStorage(file);
      return file;
    } catch { if (file != null) file.Dispose(); throw; }
  }
  static byte[] PrivateFileSecurityDescriptor() {
    var acl=new FileSecurity();
    acl.SetAccessRuleProtection(true, false);
    acl.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User,
      FileSystemRights.FullControl, AccessControlType.Allow));
    return acl.GetSecurityDescriptorBinaryForm();
  }
  static void PreserveAccess(SafeFileHandle original, SafeFileHandle replacement) {
    IntPtr owner, group, dacl, sacl, descriptor;
    uint error=GetSecurityInfo(original, 1, 4, out owner, out group, out dacl, out sacl, out descriptor);
    if (error != 0) NativeFailure(error);
    try {
      ushort control; uint revision;
      Check(GetSecurityDescriptorControl(descriptor, out control, out revision));
      uint protection=(control & 0x1000) != 0 ? 0x80000000u : 0x20000000u;
      error=SetSecurityInfo(replacement, 1, 4 | protection, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
      if (error != 0) NativeFailure(error);
      var basic=new BasicInfo { Attributes=Basic(original).Attributes & 0x27u };
      if (basic.Attributes == 0) basic.Attributes=0x80;
      Check(SetFileInformationByHandle(replacement, 0, ref basic, 40));
    } finally { LocalFree(descriptor); }
  }
  static void WritePreparedContent(SafeFileHandle file, byte[] bytes) {
    int offset=0;
    while (offset < bytes.Length) {
      var chunk=new byte[Math.Min(65536, bytes.Length-offset)];
      Buffer.BlockCopy(bytes, offset, chunk, 0, chunk.Length);
      uint written;
      Check(WriteFile(file, chunk, (uint)chunk.Length, out written, IntPtr.Zero));
      if (written == 0 || written > chunk.Length) throw new FsFault("filesystem_native_operation_failed");
      offset+=(int)written;
    }
    Check(FlushFileBuffers(file));
  }
  static object CommitWrite(Dictionary<string,object> request) {
    string[] parts=Components(request);
    if (parts.Length == 0) throw new FsFault("not_a_file");
    byte[] bytes=Convert.FromBase64String(Text(request, "content"));
    if (bytes.Length > 1048576) throw new FsFault("file_too_large");
    var expected=request["expected"] as Dictionary<string,object>;
    if (expected == null) throw new FsFault("filesystem_invalid_request");
    string name=parts[parts.Length-1];
    using (var chain=new DirectoryChain(request)) {
      chain.Walk(parts, parts.Length-1, true);
      using (var previous=ObserveExisting(chain.Current, name, expected)) {
        string temporary=".abot-"+Guid.NewGuid().ToString("N")+".tmp";
        using (var file=OpenHandle(chain.Current, temporary, false, 2, 0xC0070000, 0, PrivateFileSecurityDescriptor(), true)) {
          WritePreparedContent(file, bytes);
          using (var current=ObserveExisting(chain.Current, name, expected)) {
            if (current != null) PreserveAccess(current, file);
            PublishLinkRelative(file, chain.Current, name, current != null);
          }
          return Record("committed", true);
        }
      }
    }
  }
}
`;

// plugins/filesystem/source/windows/source.ts
var ENTRYPOINT = String.raw`
public static partial class AbotFilesystem {
  public static string Run(string input) {
    var json=new JavaScriptSerializer { MaxJsonLength=2097152 };
    try {
      var request=json.Deserialize<Dictionary<string,object>>(input);
      string operation=Text(request, "operation");
      object result;
      switch (operation) {
        case "probe": result=Record("available", true); break;
        case "read": result=ReadSlices(request); break;
        case "sample": result=SampleDirectory(request); break;
        case "write": result=CommitWrite(request); break;
        default: throw new FsFault("filesystem_invalid_request");
      }
      return json.Serialize(Record("ok", true, "result", result));
    } catch (FsFault error) { return json.Serialize(Record("ok", false, "code", error.Code)); }
      catch { return json.Serialize(Record("ok", false, "code", "filesystem_native_operation_failed")); }
  }
}
`;
var WINDOWS_FILESYSTEM_SOURCE = [
  WINDOWS_FILESYSTEM_NATIVE,
  WINDOWS_FILESYSTEM_AUTHORITY,
  WINDOWS_FILE_READ_BYTES,
  WINDOWS_FILESYSTEM_READ,
  WINDOWS_FILESYSTEM_STREAMS,
  WINDOWS_FILESYSTEM_STORAGE,
  WINDOWS_FILESYSTEM_PUBLICATION,
  WINDOWS_FILESYSTEM_WRITE,
  ENTRYPOINT
].join("\n");

// plugins/filesystem/source/windows/process.ts
var MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
var BOOTSTRAP = [
  "$ErrorActionPreference='Stop'",
  `if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { Write-Output '{"ok":false,"code":"filesystem_windows_policy_blocked"}'; exit 0 }`,
  "$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')",
  "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)",
  "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
  "$started=$false",
  "try {",
  "$envelope=[Console]::In.ReadToEnd() | ConvertFrom-Json",
  "Add-Type -ReferencedAssemblies @('System.Web.Extensions') -TypeDefinition $envelope.source",
  "$started=$true",
  "[Console]::Write([AbotFilesystem]::Run($envelope.request))",
  `} catch { if ($started) { [Console]::Write('{"ok":false,"code":"filesystem_windows_operation_unreported"}') } else { [Console]::Write('{"ok":false,"code":"filesystem_windows_helper_unavailable"}') } }`
].join(";");
var NATIVE_CODES = /* @__PURE__ */ new Set([
  "file_not_found",
  "file_too_large",
  "not_a_file",
  "not_a_directory",
  "filesystem_access_denied",
  "filesystem_safe_io_unsupported",
  "filesystem_storage_attributes_unsupported",
  "filesystem_named_streams_unsupported",
  "filesystem_windows_publication_unsupported",
  "filesystem_path_changed",
  "filesystem_target_changed",
  "filesystem_invalid_path",
  "filesystem_read_changed",
  "filesystem_read_incomplete",
  "filesystem_invalid_request",
  "filesystem_native_operation_failed",
  "filesystem_windows_policy_blocked",
  "filesystem_windows_helper_unavailable"
]);
function isWindowsHelperBlocked(error) {
  if (!(error instanceof FilesystemToolError)) return false;
  return error.code === "filesystem_windows_policy_blocked" || error.code === "filesystem_windows_helper_unavailable";
}
function helperFailure(code, mutation) {
  if (code === "filesystem_windows_publication_unsupported")
    return new FilesystemToolError(
      code,
      "Windows cannot safely publish this file. Writes require Windows 10 version 1809 or newer and a filesystem supporting hard links, such as NTFS. The destination was left unchanged. Do not retry this write on the same unsupported target.",
      {
        retryable: false,
        blockedBy: "filesystem_publication_support",
        targetUnchanged: true
      }
    );
  if (code === "filesystem_named_streams_unsupported")
    return new FilesystemToolError(
      code,
      "This file has Windows named data streams, which may include download-origin security information. Editing it is not supported; the original file and its streams were left unchanged. Do not retry this edit or remove the streams to bypass the restriction.",
      {
        retryable: false,
        blockedBy: "file_named_streams",
        targetUnchanged: true
      }
    );
  if (code === "filesystem_storage_attributes_unsupported")
    return new FilesystemToolError(
      code,
      "This file uses EFS encryption or NTFS compression. Editing it is not supported; the original file was left unchanged. Do not retry this edit or remove its storage attributes to bypass the restriction.",
      {
        retryable: false,
        blockedBy: "file_storage_attributes",
        targetUnchanged: true
      }
    );
  if (code === "filesystem_windows_policy_blocked")
    return new FilesystemToolError(
      code,
      "Windows policy blocks the filesystem helper. No file operation ran. Retrying cannot resolve this restriction; ask the user to contact their administrator. Do not bypass the restriction.",
      {
        retryable: false,
        blockedBy: "system_policy",
        operationOutcome: "not_started"
      }
    );
  if (code === "filesystem_windows_helper_unavailable")
    return new FilesystemToolError(
      code,
      "The Windows filesystem helper is unavailable. No file operation ran. Do not retry in this request; the user must resolve helper availability first.",
      {
        retryable: false,
        blockedBy: "helper_availability",
        operationOutcome: "not_started"
      }
    );
  return new FilesystemToolError(
    code,
    mutation ? "The filesystem helper did not report a completed operation. The file state is unknown; do not repeat the write automatically." : "The Windows filesystem helper did not complete the read.",
    {
      retryable: false,
      operationOutcome: mutation ? "unknown" : "not_started"
    }
  );
}
async function runWindowsFilesystem(request, signal, spawnProcess = import_node_child_process.spawn) {
  const mutation = request.operation === "write";
  if (signal?.aborted)
    throw helperFailure("filesystem_windows_interrupted", false);
  const input = JSON.stringify({
    source: WINDOWS_FILESYSTEM_SOURCE,
    request: JSON.stringify(request)
  });
  if (Buffer.byteLength(input) > MAX_MESSAGE_BYTES)
    throw new FilesystemToolError(
      "filesystem_invalid_request",
      "Filesystem helper input exceeds its byte limit."
    );
  const executable = (0, import_node_path2.join)(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const raw = await new Promise((resolve, reject) => {
    const child = spawnProcess(
      executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", BOOTSTRAP],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
    );
    const chunks = [];
    let bytes = 0;
    let failure;
    const stop = (code2) => {
      failure ??= helperFailure(code2, mutation);
      child.kill("SIGKILL");
    };
    const abort = () => stop("filesystem_windows_interrupted");
    const timer = setTimeout(() => stop("filesystem_windows_timeout"), 15e3);
    timer.unref();
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_MESSAGE_BYTES) {
        stop("filesystem_windows_output_limit");
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on("error", () => stop("filesystem_windows_transport_failed"));
    child.once("error", () => {
      failure ??= child.pid === void 0 ? helperFailure("filesystem_windows_helper_unavailable", false) : helperFailure("filesystem_windows_transport_failed", mutation);
    });
    child.once("close", (code2) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure) {
        reject(failure);
        return;
      }
      if (code2 !== 0) {
        reject(helperFailure("filesystem_windows_transport_failed", mutation));
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    if (signal?.aborted) {
      abort();
      return;
    }
    child.stdin.end(input, "utf8");
  });
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw helperFailure("filesystem_windows_response_invalid", mutation);
  }
  if (envelope?.ok === true) return envelope.result;
  const code = typeof envelope?.code === "string" ? envelope.code : "";
  if (!NATIVE_CODES.has(code))
    throw helperFailure("filesystem_windows_response_invalid", mutation);
  if (isDirectoryTypeFailure(code)) failNotDirectory();
  if (code === "filesystem_storage_attributes_unsupported" || code === "filesystem_named_streams_unsupported")
    throw helperFailure(code, mutation);
  if (code.startsWith("filesystem_windows_")) throw helperFailure(code, false);
  throw new FilesystemToolError(
    code,
    "The filesystem operation was rejected: " + code + "."
  );
}

// plugins/filesystem/source/windows/request-availability.ts
var currentRequest = new import_node_async_hooks.AsyncLocalStorage();
async function executeWindowsFilesystem(request) {
  const scope = currentRequest.getStore();
  if (scope?.availability.blocked) throw scope.availability.blocked;
  try {
    return await runWindowsFilesystem(request, scope?.signal);
  } catch (error) {
    if (scope && isWindowsHelperBlocked(error))
      scope.availability.blocked = error;
    throw error;
  }
}
var prepareFilesystemRequest = async (modules) => {
  if (process.platform !== "win32" || modules.length === 0) return modules;
  try {
    const result = await runWindowsFilesystem({ operation: "probe" });
    if (!result || typeof result !== "object" || !("available" in result) || result.available !== true)
      return Object.freeze([]);
  } catch {
    return Object.freeze([]);
  }
  const availability = {};
  return Object.freeze(
    modules.map((module2) => ({
      ...module2,
      implementation: (params, context) => {
        if (availability.blocked)
          return Promise.resolve(
            failureResult({
              errorCode: availability.blocked.code,
              message: availability.blocked.message,
              data: availability.blocked.data
            })
          );
        return currentRequest.run(
          { availability, signal: context?.abortSignal },
          () => module2.implementation(params, context)
        );
      }
    }))
  );
};

// plugins/filesystem-ea/source/range-references.ts
var import_node_crypto = require("node:crypto");
var STATE_KEY = "filesystem-ea.v1";
var MAX_RANGES = 32;
var MAX_BINDINGS = 128;
var MAX_STATE_BYTES = 1048576;
function createRangeReferences(context) {
  if (!context?.requestId) invalidState();
  const requestId = context.requestId;
  let closed = false;
  const assertOpen = () => {
    if (closed) fail("ea_request_closed", "This file request has ended.");
  };
  const ranges = /* @__PURE__ */ new Map();
  const bindings = /* @__PURE__ */ new Map();
  const restored = context?.requestState?.read(STATE_KEY);
  if (restored !== void 0) {
    if (!isRecord(restored) || restored.version !== 1 || restored.requestId !== requestId || !Array.isArray(restored.ranges) || !Array.isArray(restored.bindings) || restored.ranges.length > MAX_RANGES || restored.bindings.length > MAX_BINDINGS || Buffer.byteLength(JSON.stringify(restored)) > MAX_STATE_BYTES) invalidState();
    for (const range of restored.ranges) {
      if (!isRecord(range) || !validBase(range) || !validOffsets(range) || typeof range.targetPath !== "string" || !range.targetPath.length || range.targetPath.length > 4096 || typeof range.text !== "string" || range.text.length !== Number(range.end) - Number(range.start) || Buffer.byteLength(range.text) > 24e3) invalidState();
      if (ranges.has(range.id)) invalidState();
      ranges.set(range.id, Object.freeze(range));
    }
    for (const binding of restored.bindings) {
      if (!isRecord(binding) || !validBase(binding) || !["create", "exact", "range"].includes(String(binding.mode)) || binding.mode === "range" && !validOffsets(binding) || binding.bodyDigest !== void 0 && !/^[a-f0-9]{64}$/.test(String(binding.bodyDigest))) invalidState();
      if (bindings.has(binding.id)) invalidState();
      bindings.set(binding.id, Object.freeze(binding));
    }
  }
  const dispose = () => {
    closed = true;
    ranges.clear();
    bindings.clear();
  };
  const snapshot = () => ({ version: 1, requestId, ranges: [...ranges.values()], bindings: [...bindings.values()] });
  const reservedBytes = () => Buffer.byteLength(JSON.stringify(snapshot())) + [...bindings.values()].filter((binding) => binding.bodyDigest === void 0).length * 80;
  if (reservedBytes() > MAX_STATE_BYTES) invalidState();
  context?.requestState?.register(STATE_KEY, { snapshot, dispose });
  if (!context?.requestState) context?.onRequestDispose?.(dispose);
  return Object.freeze({
    observe(input) {
      assertOpen();
      while (ranges.size >= MAX_RANGES) ranges.delete(ranges.keys().next().value);
      const id = `range:${(0, import_node_crypto.randomUUID)()}`;
      ranges.set(id, Object.freeze({ ...input, id }));
      while (reservedBytes() > MAX_STATE_BYTES) {
        ranges.delete(ranges.keys().next().value);
      }
      if (!ranges.has(id)) fail("ea_request_state_limit", "The request has no room for another exact file window.");
      return id;
    },
    resolve(id, path, version) {
      assertOpen();
      const range = ranges.get(id);
      if (!range || range.path !== path) fail("ea_range_invalid", "The range reference is not available for this request and path. Read the desired range again.");
      if (range.version !== version) fail("filesystem_target_changed", "The file changed after the range was read. Read it again.");
      return range;
    },
    bind(input) {
      assertOpen();
      if (bindings.size >= MAX_BINDINGS) fail("ea_binding_limit", "The request reached its prepared file edit limit.");
      const binding = Object.freeze({ ...input, id: `payload:${(0, import_node_crypto.randomUUID)()}` });
      bindings.set(binding.id, binding);
      if (reservedBytes() > MAX_STATE_BYTES) {
        bindings.delete(binding.id);
        fail("ea_request_state_limit", "The request has no room for another prepared file edit.");
      }
      return binding;
    },
    seal(id, bodyDigest) {
      assertOpen();
      const binding = bindings.get(id);
      if (!binding || binding.bodyDigest !== void 0) fail("ea_payload_binding_invalid", "The source binding is unavailable or already used.");
      bindings.set(id, Object.freeze({ ...binding, bodyDigest }));
    },
    payload(id) {
      assertOpen();
      const binding = bindings.get(id);
      if (!binding) fail("ea_payload_binding_invalid", "The prepared payload is not owned by this request.");
      return binding;
    },
    forget(id) {
      bindings.delete(id);
    }
  });
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validBase(value) {
  return ["id", "path", "version"].every((key) => typeof value[key] === "string" && value[key].length > 0 && value[key].length <= 8192);
}
function validOffsets(value) {
  return Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end) && Number(value.start) >= 0 && Number(value.end) >= Number(value.start) && Number(value.end) <= 1048576;
}
function invalidState() {
  return fail("ea_request_state_invalid", "The saved EA file state is invalid.");
}

// plugins/filesystem-ea/source/snapshot.ts
var import_node_crypto3 = require("node:crypto");
var import_node_util2 = require("node:util");

// plugins/filesystem/source/bounded-io.ts
var import_node_crypto2 = require("node:crypto");
var import_node_util = require("node:util");

// plugins/filesystem/source/file-observation.ts
var import_node_fs = require("node:fs");
var import_promises2 = require("node:fs/promises");
var import_node_path4 = require("node:path");

// plugins/filesystem/source/file-version.ts
function metadataFromStat(info, logicalPath) {
  if (info.size > BigInt(Number.MAX_SAFE_INTEGER))
    fail("file_too_large", `File is too large to read safely: ${logicalPath}`);
  return Object.freeze({
    device: info.dev,
    inode: info.ino,
    size: Number(info.size),
    mode: Number(info.mode) & 4095,
    modifiedNs: info.mtimeNs,
    changedNs: info.ctimeNs
  });
}
function sameMetadata(left, right) {
  return left.device === right.device && left.inode === right.inode && left.size === right.size && left.mode === right.mode && left.modifiedNs === right.modifiedNs && left.changedNs === right.changedNs;
}

// plugins/filesystem/source/windows/operations.ts
var import_promises = require("node:fs/promises");
var import_node_path3 = require("node:path");
async function withTarget(target, run) {
  const expectedPath = import_node_path3.win32.resolve(target.rootPath, target.relativePath);
  if (import_node_path3.win32.relative(expectedPath, target.absolutePath) !== "")
    fail(
      "filesystem_path_changed",
      "The resolved file target no longer matches its root."
    );
  const relative3 = import_node_path3.win32.relative(target.rootPath, expectedPath);
  if (import_node_path3.win32.isAbsolute(relative3) || relative3 === ".." || relative3.startsWith("..\\"))
    fail(
      "filesystem_path_changed",
      "The file target is outside its configured root."
    );
  let root;
  try {
    root = await (0, import_promises.open)(target.rootPath, "r");
    const identity = await root.stat({ bigint: true });
    if (!identity.isDirectory())
      fail("not_a_directory", "The configured root is not a directory.");
    if (identity.ino <= 0n)
      fail(
        "filesystem_safe_io_unsupported",
        "The configured filesystem does not provide a stable file identity."
      );
    return await run(
      {
        rootPath: target.rootPath,
        relativePath: target.relativePath,
        rootIdentity: {
          device: String(identity.dev),
          inode: String(identity.ino),
          birthtimeNs: String(identity.birthtimeNs)
        }
      },
      root
    );
  } catch (error) {
    return rethrowFilesystemError(error, "inspect", target.logicalPath);
  } finally {
    await root?.close().catch(() => void 0);
  }
}
function decodeMetadata(value) {
  const validSize = Number.isSafeInteger(value?.size) && value.size >= 0;
  if (!validSize || !Number.isSafeInteger(value?.mode))
    fail(
      "filesystem_windows_response_invalid",
      "The filesystem helper returned invalid file metadata."
    );
  const fields = [value.device, value.inode, value.modifiedNs, value.changedNs];
  if (!fields.every(
    (field) => typeof field === "string" && /^-?\d{1,30}$/u.test(field)
  ))
    fail(
      "filesystem_windows_response_invalid",
      "The filesystem helper returned invalid file identity."
    );
  return Object.freeze({
    device: BigInt(value.device),
    inode: BigInt(value.inode),
    size: value.size,
    mode: value.mode,
    modifiedNs: BigInt(value.modifiedNs),
    changedNs: BigInt(value.changedNs)
  });
}
async function readWindowsFileSlices(target, options) {
  return withTarget(target, async (request) => {
    const result = await executeWindowsFilesystem({
      ...request,
      operation: "read",
      ...options,
      maximumFileBytes: options.maximumFileBytes ?? 0
    });
    const metadata = decodeMetadata(result?.metadata);
    if (typeof result.head !== "string" || typeof result.tail !== "string")
      fail(
        "filesystem_windows_response_invalid",
        "The filesystem helper returned invalid file bytes."
      );
    const head = Buffer.from(result.head, "base64"), tail = Buffer.from(result.tail, "base64");
    const complete = metadata.size <= options.headBytes + options.tailBytes;
    const expectedHead = complete ? metadata.size : options.headBytes;
    const expectedTail = complete ? 0 : options.tailBytes;
    if (head.length !== expectedHead || tail.length !== expectedTail)
      fail(
        "filesystem_read_incomplete",
        "The filesystem helper returned incomplete file bytes."
      );
    return Object.freeze({ metadata, head, tail });
  });
}
async function writeWindowsFile(input) {
  await withTarget(input.target, async (request, root) => {
    const expected = Object.fromEntries(
      Object.entries(input.expectedVersion).map(([key, value]) => [
        key,
        typeof value === "bigint" ? String(value) : value
      ])
    );
    const result = await executeWindowsFilesystem({
      ...request,
      operation: "write",
      content: Buffer.from(input.content, "utf8").toString("base64"),
      expected
    });
    if (result?.committed !== true)
      fail(
        "filesystem_windows_response_invalid",
        "The filesystem helper did not confirm the write; do not repeat it automatically."
      );
    try {
      input.onCommitted?.(root);
    } catch {
    }
  });
}

// plugins/filesystem/source/file-observation.ts
async function readExactBytes(reader, buffer, position, logicalPath) {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await reader.read(
      buffer,
      offset,
      buffer.length - offset,
      position + offset
    );
    if (result.bytesRead <= 0 || result.bytesRead > buffer.length - offset) {
      fail(
        "filesystem_read_incomplete",
        `File changed or ended before a complete read: ${logicalPath}`
      );
    }
    offset += result.bytesRead;
  }
}
async function openRegularFile(target) {
  let handle;
  try {
    if (typeof import_node_fs.constants.O_NOFOLLOW !== "number") {
      fail(
        "filesystem_safe_io_unsupported",
        "This platform does not provide the no-follow operation required for a safe read."
      );
    }
    handle = await (0, import_promises2.open)(
      target.absolutePath,
      import_node_fs.constants.O_RDONLY | import_node_fs.constants.O_NOFOLLOW
    );
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) {
      fail("not_a_file", `Expected a regular file: ${target.logicalPath}`);
    }
    const metadata = metadataFromStat(info, target.logicalPath);
    const [canonicalRoot, canonicalTarget] = await Promise.all([
      (0, import_promises2.realpath)(target.rootPath),
      (0, import_promises2.realpath)(target.absolutePath)
    ]);
    const rootRelative = (0, import_node_path4.relative)(canonicalRoot, canonicalTarget);
    if (rootRelative === ".." || rootRelative.startsWith(`..${import_node_path4.sep}`) || rootRelative.startsWith(import_node_path4.sep)) {
      fail(
        "filesystem_path_changed",
        `File changed outside its configured root: ${target.logicalPath}`
      );
    }
    const pathIdentity = await (0, import_promises2.stat)(canonicalTarget, { bigint: true });
    if (!pathIdentity.isFile() || pathIdentity.dev !== info.dev || pathIdentity.ino !== info.ino) {
      fail(
        "filesystem_path_changed",
        `File changed while it was being opened: ${target.logicalPath}`
      );
    }
    return Object.freeze({ handle, size: metadata.size, metadata });
  } catch (error) {
    await handle?.close().catch(() => void 0);
    rethrowFilesystemError(error, "inspect", target.logicalPath);
  }
}
async function observeFileSlices(target, options) {
  if (process.platform === "win32")
    return readWindowsFileSlices(target, options);
  const file = await openRegularFile(target);
  try {
    if (options.maximumFileBytes !== void 0 && file.size > options.maximumFileBytes)
      fail(
        "file_too_large",
        `File exceeds the mutation byte limit: ${target.logicalPath}`,
        { byteCount: file.size, maxBytes: options.maximumFileBytes }
      );
    const complete = file.size <= options.headBytes + options.tailBytes;
    const head = Buffer.alloc(complete ? file.size : options.headBytes);
    const tail = Buffer.alloc(complete ? 0 : options.tailBytes);
    await readExactBytes(file.handle, head, 0, target.logicalPath);
    await readExactBytes(
      file.handle,
      tail,
      file.size - tail.length,
      target.logicalPath
    );
    const after = metadataFromStat(
      await file.handle.stat({ bigint: true }),
      target.logicalPath
    );
    if (!sameMetadata(file.metadata, after))
      fail(
        "filesystem_read_changed",
        `File changed while it was being read: ${target.logicalPath}`
      );
    return Object.freeze({ metadata: file.metadata, head, tail });
  } catch (error) {
    return rethrowFilesystemError(error, "read", target.logicalPath);
  } finally {
    await file.handle.close().catch(() => void 0);
  }
}

// src/shared/directory-authority/bootstrap.ts
function directoryAuthorityBootstrap(mode, messageLimit, task) {
  const fs = require("node:fs");
  function fail2(code, message) {
    throw Object.assign(new Error(message), { code });
  }
  function verifyDirectoryAuthority() {
    const expected = fs.fstatSync(3, { bigint: true });
    const actual = fs.statSync(".", { bigint: true });
    const matchesHeldDirectory = expected.isDirectory() && actual.isDirectory() && expected.dev === actual.dev && expected.ino === actual.ino;
    if (matchesHeldDirectory) return;
    fail2(
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
        fail2(
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
      fail2("directory_authority_failed", "The directory task is missing.");
    const result = await task(input);
    const encoded = JSON.stringify({ ok: true, result });
    if (Buffer.byteLength(encoded) > messageLimit) {
      fail2(
        "directory_authority_result_too_large",
        "The directory operation result exceeds the bridge byte limit."
      );
    }
    writeResponse(1, encoded);
  }
  function runCommand(input) {
    const { spawn: spawn3 } = require("node:child_process");
    const command = input;
    const child = spawn3(command.command, command.args, {
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
var import_node_path5 = require("node:path");

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
var AUTHORITY_TASK_TIMEOUT_MS = 3e4;
function assertDirectoryAuthorityLocation(location) {
  if (!(0, import_node_path5.isAbsolute)(location.directoryPath)) {
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
function isAuthorityMessageObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function decodeAuthorityResult(output) {
  let message;
  try {
    message = JSON.parse(output);
  } catch {
    throw new DirectoryAuthorityError(
      "directory_authority_protocol_error",
      "The directory operation returned an invalid response."
    );
  }
  if (!isAuthorityMessageObject(message)) {
    throw new DirectoryAuthorityError(
      "directory_authority_protocol_error",
      "The directory operation returned an invalid response."
    );
  }
  if (message.ok === true) return message.result;
  const hasAuthorityError = message.ok === false && isAuthorityMessageObject(message.error);
  if (!hasAuthorityError) {
    throw new DirectoryAuthorityError(
      "directory_authority_protocol_error",
      "The directory operation returned an invalid response."
    );
  }
  const {
    code,
    message: explanation,
    data
  } = message.error;
  const hasErrorDescription = typeof code === "string" && typeof explanation === "string";
  if (!hasErrorDescription) {
    throw new DirectoryAuthorityError(
      "directory_authority_protocol_error",
      "The directory operation returned an invalid error response."
    );
  }
  throw new DirectoryAuthorityError(
    code,
    explanation,
    isAuthorityMessageObject(data) ? data : void 0
  );
}

// src/shared/directory-authority/task.ts
var import_node_child_process2 = require("node:child_process");
async function runDirectoryAuthorityTask(input) {
  assertDirectoryAuthorityLocation(input);
  const request = encodeAuthorityRequest(input.input);
  const timeoutMs = input.timeoutMs ?? AUTHORITY_TASK_TIMEOUT_MS;
  const hasPositiveDeadline = Number.isFinite(timeoutMs) && timeoutMs > 0;
  if (!hasPositiveDeadline) {
    throw new DirectoryAuthorityError(
      "directory_authority_invalid_timeout",
      "The directory operation deadline must be a positive finite duration."
    );
  }
  if (input.signal?.aborted) {
    throw new DirectoryAuthorityError(
      "directory_authority_aborted",
      "The directory operation was cancelled before it started."
    );
  }
  const child = (0, import_node_child_process2.spawn)(
    process.execPath,
    [
      "--input-type=commonjs",
      "-e",
      directoryAuthorityScript("task", AUTHORITY_MESSAGE_LIMIT, input.task)
    ],
    {
      cwd: input.directoryPath,
      env: authorityEnvironment(),
      detached: true,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe", input.directoryFd]
    }
  );
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stderrChunks = [];
    let bytes = 0;
    let stderrBytes = 0;
    let failure;
    const stop = (error) => {
      if (failure) return;
      failure = error;
      if (typeof child.pid === "number") {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
        }
      }
      child.kill("SIGKILL");
    };
    const onAbort = () => stop(
      new DirectoryAuthorityError(
        "directory_authority_aborted",
        "The directory operation was cancelled."
      )
    );
    const timer = setTimeout(
      () => stop(
        new DirectoryAuthorityError(
          "directory_authority_timeout",
          "The directory operation exceeded its deadline."
        )
      ),
      timeoutMs
    );
    timer.unref();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > AUTHORITY_MESSAGE_LIMIT) {
        stop(
          new DirectoryAuthorityError(
            "directory_authority_result_too_large",
            "The directory operation result exceeds the bridge byte limit."
          )
        );
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      const remaining = Math.max(AUTHORITY_STDERR_LIMIT - stderrBytes, 0);
      if (remaining === 0) return;
      stderrChunks.push(chunk.subarray(0, remaining));
      stderrBytes += Math.min(chunk.length, remaining);
    });
    child.stdin.on("error", () => void 0);
    child.once("error", (error) => {
      failure ??= new DirectoryAuthorityError(
        "directory_authority_unavailable",
        `The directory operation could not start: ${error.message}`
      );
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      if (failure) {
        reject(failure);
        return;
      }
      if (code !== 0) {
        reject(
          new DirectoryAuthorityError(
            "directory_authority_failed",
            "The directory operation process did not complete successfully.",
            {
              exitCode: code,
              signal,
              stderr: Buffer.concat(stderrChunks).toString("utf8")
            }
          )
        );
        return;
      }
      try {
        resolve(
          decodeAuthorityResult(Buffer.concat(chunks).toString("utf8"))
        );
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(request);
  });
}

// plugins/filesystem/source/bounded-io.ts
var MAX_MUTATION_BYTES = 1048576;
function decodeMutationText(buffer, logicalPath) {
  try {
    return new import_node_util.TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    fail(
      "filesystem_invalid_encoding",
      `File is not valid UTF-8 text: ${logicalPath}`
    );
  }
}
async function readMutationSnapshot(target) {
  try {
    const observed = await observeFileSlices(target, {
      headBytes: MAX_MUTATION_BYTES,
      tailBytes: 0,
      maximumFileBytes: MAX_MUTATION_BYTES
    });
    rejectBinary(observed.head, target.logicalPath);
    return Object.freeze({
      content: decodeMutationText(observed.head, target.logicalPath),
      version: Object.freeze({
        kind: "file",
        ...observed.metadata,
        digest: digest(observed.head)
      })
    });
  } catch (error) {
    if (error instanceof FilesystemToolError && error.code === "file_not_found")
      return Object.freeze({
        content: null,
        version: Object.freeze({ kind: "absent" })
      });
    if (error instanceof FilesystemToolError && error.code === "filesystem_read_changed")
      failTargetChanged(target.logicalPath, "file", "file");
    return rethrowFilesystemError(error, "read", target.logicalPath);
  }
}
async function assertMutationTargetUnchanged(target, expected) {
  let current;
  try {
    current = await readMutationSnapshot(target);
  } catch (error) {
    const changedContents = error instanceof FilesystemToolError && [
      "file_too_large",
      "binary_file_unsupported",
      "filesystem_invalid_encoding"
    ].includes(error.code);
    if (changedContents)
      failTargetChanged(target.logicalPath, expected.kind, "file");
    throw error;
  }
  if (current.version.kind !== expected.kind)
    failTargetChanged(target.logicalPath, expected.kind, current.version.kind);
  if (current.version.kind === "absent" || expected.kind === "absent") return;
  if (!sameMetadata(expected, current.version) || expected.digest !== current.version.digest)
    failTargetChanged(target.logicalPath, "file", "file");
}
function assertMutationContentSize(content) {
  const byteCount = Buffer.byteLength(content, "utf8");
  if (byteCount > MAX_MUTATION_BYTES) {
    fail(
      "file_too_large",
      `Prepared content exceeds the ${MAX_MUTATION_BYTES}-byte mutation limit.`,
      { byteCount, maxBytes: MAX_MUTATION_BYTES }
    );
  }
  return byteCount;
}
function rejectBinary(buffer, logicalPath) {
  if (buffer.includes(0))
    fail(
      "binary_file_unsupported",
      `Binary file is not supported: ${logicalPath}`
    );
}
function digest(buffer) {
  return (0, import_node_crypto2.createHash)("sha256").update(buffer).digest("hex");
}
function failTargetChanged(logicalPath, expectedState, observedState) {
  fail(
    "filesystem_target_changed",
    `Target changed while the mutation was being prepared; no file was written: ${logicalPath}`,
    { path: logicalPath, expectedState, observedState }
  );
}

// plugins/filesystem-ea/source/snapshot.ts
function digest2(value) {
  return (0, import_node_crypto3.createHash)("sha256").update(value).digest("hex");
}
function versionKey(version) {
  return JSON.stringify(version, (_key, value) => typeof value === "bigint" ? value.toString() : value);
}
async function readSnapshot(target) {
  try {
    const observed = await observeFileSlices(target, {
      headBytes: MAX_MUTATION_BYTES,
      tailBytes: 0,
      maximumFileBytes: MAX_MUTATION_BYTES
    });
    if (observed.head.includes(0)) fail("binary_file_unsupported", "Expected UTF-8 text.");
    let content;
    try {
      content = new import_node_util2.TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(observed.head);
    } catch {
      fail("filesystem_invalid_encoding", "Expected valid UTF-8 text.");
    }
    return { content, version: { kind: "file", ...observed.metadata, digest: digest2(observed.head) } };
  } catch (error) {
    if (error instanceof FilesystemToolError && error.code === "file_not_found") {
      return { content: null, version: { kind: "absent" } };
    }
    throw error;
  }
}
function lineAt(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

// plugins/filesystem-ea/source/read-window.ts
var MAX_READ_BYTES = 24e3;
var DEFAULT_READ_LINES = 120;
function selectReadWindow(content, params) {
  if (hasByteSelection(params)) return selectByteWindow(content, params);
  const defaultByteBudget = readDefaultByteBudget(params);
  if (hasLineSelection(params)) return selectLineWindow(content, params);
  return selectLineWindow(content, { ...params, start_line: 1, end_line: DEFAULT_READ_LINES }, defaultByteBudget);
}
function hasLineSelection(params) {
  if (params.start_line !== void 0) return true;
  if (params.end_line !== void 0) return true;
  return params.locator !== void 0;
}
function hasByteSelection(params) {
  return params.start_byte !== void 0;
}
function readDefaultByteBudget(params) {
  if (params.max_bytes === void 0) return MAX_READ_BYTES;
  assertByteControlsAreExclusive(params);
  return readByteWindowInteger(params.max_bytes, 1, MAX_READ_BYTES, "max_bytes");
}
function selectByteWindow(content, params) {
  assertByteControlsAreExclusive(params);
  const bytes = Buffer.from(content, "utf8");
  const startByte = readByteWindowInteger(params.start_byte, 0, bytes.length, "start_byte");
  const maxBytes = readByteWindowInteger(
    params.max_bytes === void 0 ? MAX_READ_BYTES : params.max_bytes,
    1,
    MAX_READ_BYTES,
    "max_bytes"
  );
  assertUtf8StartBoundary(bytes, startByte);
  const endByte = utf8WindowEnd(bytes, Math.min(bytes.length, startByte + maxBytes));
  assertByteWindowMakesProgress(startByte, endByte, bytes.length);
  const text = bytes.subarray(startByte, endByte).toString("utf8");
  const start = bytes.subarray(0, startByte).toString("utf8").length;
  return {
    start,
    end: start + text.length,
    text,
    startLine: lineAt(content, start),
    totalLines: lineAt(content, content.length),
    truncated: false,
    complete: startByte === 0 && endByte === bytes.length,
    totalBytes: bytes.length,
    byteRange: {
      start_byte: startByte,
      end_byte: endByte,
      ...endByte < bytes.length ? { next_byte: endByte } : {}
    }
  };
}
function assertByteControlsAreExclusive(params) {
  for (const key of ["start_line", "end_line", "locator", "context_lines"]) {
    if (params[key] !== void 0)
      fail("ea_read_range_invalid", "Byte controls cannot be combined with explicit line or locator controls.");
  }
}
function readByteWindowInteger(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value)) fail("ea_read_range_invalid", `${name} must be an integer.`);
  const result = Number(value);
  if (result < minimum || result > maximum)
    fail("ea_read_range_invalid", `${name} must be between ${minimum} and ${maximum}.`);
  return result;
}
function assertByteWindowMakesProgress(start, end, fileBytes) {
  if (end > start) return;
  if (start === fileBytes) return;
  fail("ea_read_range_invalid", "max_bytes is too small for the next UTF-8 character.");
}
function assertUtf8StartBoundary(bytes, start) {
  if (isUtf8ContinuationByte(bytes, start))
    fail("ea_read_range_invalid", "start_byte must be a UTF-8 character boundary; use a returned next_byte.");
}
function isUtf8ContinuationByte(bytes, offset) {
  if (offset >= bytes.length) return false;
  return (bytes[offset] & 192) === 128;
}
function utf8WindowEnd(bytes, end) {
  while (isUtf8ContinuationByte(bytes, end)) end--;
  return end;
}
function selectLineWindow(content, params, maxBytes = MAX_READ_BYTES) {
  const offsets = [0];
  for (let index = 0; index < content.length; index++) if (content[index] === "\n") offsets.push(index + 1);
  const totalLines = offsets.length;
  let startLine = lineInteger(params.start_line, 1);
  let endLine = lineInteger(params.end_line, totalLines);
  if (params.locator !== void 0) {
    const locator = readRequiredString(params.locator, "locator");
    const offset = content.indexOf(locator);
    if (offset < 0) fail("ea_locator_not_found", "The exact locator was not found.");
    const around = lineInteger(params.context_lines, 12);
    startLine = Math.max(1, lineAt(content, offset) - around);
    endLine = Math.min(totalLines, lineAt(content, offset + locator.length) + around);
  }
  if (startLine > totalLines || endLine < startLine)
    fail("ea_read_range_invalid", "The requested line range is outside this file.");
  endLine = Math.min(totalLines, endLine);
  const start = offsets[startLine - 1];
  const requestedEnd = offsets[endLine] ?? content.length;
  const requested = content.slice(start, requestedEnd);
  const bytes = Buffer.from(requested, "utf8");
  const text = bytes.subarray(0, utf8WindowEnd(bytes, Math.min(bytes.length, maxBytes))).toString("utf8");
  const end = start + text.length;
  return {
    start,
    end,
    text,
    startLine,
    totalLines,
    truncated: text.length !== requested.length,
    complete: start === 0 && end === content.length
  };
}
function lineInteger(value, fallback) {
  if (value === void 0) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 1e6)
    fail("ea_read_range_invalid", "Expected a positive integer line bound.");
  return Number(value);
}

// plugins/filesystem-ea/source/read-text.ts
function createReadTextHandler(paths, references) {
  return async (params, context) => {
    const target = paths.resolve(readRequiredString(params.path, "path"), context);
    const snapshot = await readSnapshot(target);
    if (snapshot.content === null) fail("file_not_found", "The requested text file does not exist.");
    const content = snapshot.content;
    const window = selectReadWindow(content, params);
    const { start, end: actualEnd, text, startLine, totalLines, truncated, complete, byteRange } = window;
    const rangeRef = truncated ? void 0 : references.observe({
      path: target.absolutePath,
      targetPath: target.logicalPath,
      version: versionKey(snapshot.version),
      start,
      end: actualEnd,
      text
    });
    const output = [
      `Path: ${target.logicalPath}`,
      `Coverage: ${complete ? "complete file" : truncated ? "truncated window" : "complete requested window"}`,
      `Lines: ${startLine}-${lineAt(content, Math.max(start, actualEnd - 1))} of ${totalLines}`,
      ...byteRange ? [`Bytes: ${byteRange.start_byte}-${byteRange.end_byte} of ${window.totalBytes} (zero-based, end-exclusive)`] : [],
      ...byteRange?.next_byte !== void 0 ? [`next_byte: ${byteRange.next_byte}`] : [],
      ...rangeRef ? [`range_ref: ${rangeRef}`] : [],
      "Content:",
      text
    ].join("\n");
    return successResult({ output, progress: true, data: {
      hasData: true,
      path: target.logicalPath,
      range_ref: rangeRef,
      ...byteRange,
      observationMeta: { kind: "volatile_external", carryPolicy: "never" },
      eventMeta: {
        path: target.logicalPath,
        operation: "read",
        mode: "file",
        startLine,
        endLine: lineAt(content, Math.max(start, actualEnd - 1)),
        totalLines,
        byteCount: Buffer.byteLength(text),
        truncated,
        complete,
        outputPreview: text.slice(0, 1200),
        outputPreviewTruncated: text.length > 1200
      }
    } }, context?.resultBudget);
  };
}

// plugins/filesystem-ea/source/payload-source.ts
var EA_FILE_PAYLOAD_CONTRACT = "execution_file_v1";
var MAX_AUTHORED_BYTES = 262144;
function createPayloadAdapter(paths, references, operation) {
  return {
    async preparePayload(input, context) {
      context.abortSignal?.throwIfAborted();
      const rangeRef = readSelectedRangeReference(operation, input.params.range_ref);
      const target = paths.resolve(input.params.path);
      const snapshot = await readSnapshot(target);
      assertOperationTargetExists(operation, snapshot.content);
      const version = versionKey(snapshot.version);
      const range = rangeRef === void 0 ? void 0 : references.resolve(rangeRef, target.absolutePath, version);
      const source = selectPayloadSource(operation, range);
      const binding = references.bind({
        path: target.absolutePath,
        version,
        mode: source.mode,
        ...range ? { start: range.start, end: range.end } : {}
      });
      return Object.freeze({
        authoringContract: EA_FILE_PAYLOAD_CONTRACT,
        context: Object.freeze({ path: target.logicalPath, ...source, maxBytes: MAX_AUTHORED_BYTES }),
        bind(body) {
          if (Buffer.byteLength(body) > MAX_AUTHORED_BYTES)
            fail("ea_payload_too_large", "The authored payload exceeds the file payload limit.");
          references.seal(binding.id, digest2(body));
          return JSON.stringify({ binding: binding.id, body });
        }
      });
    },
    validateCall(input) {
      try {
        boundPayload(input, paths, references);
        return null;
      } catch {
        return { error: "ea_payload_binding_invalid" };
      }
    },
    async executionBinding(input, context) {
      context.abortSignal?.throwIfAborted();
      const bound2 = boundPayload(input, paths, references);
      const snapshot = await readSnapshot(bound2.target);
      if (versionKey(snapshot.version) !== bound2.binding.version)
        fail("filesystem_target_changed", "The target changed after payload preparation. Read it again.");
      return { identity: bound2.identity, metadata: {
        path: bound2.target.logicalPath,
        operation: bound2.binding.mode === "create" ? "create" : "edit"
      } };
    }
  };
}
function readSelectedRangeReference(operation, value) {
  if (operation === "create") return void 0;
  if (typeof value !== "string" || !value.trim())
    fail("ea_range_required", "edit_text requires a range_ref from read_text for this file.");
  return value;
}
function assertOperationTargetExists(operation, content) {
  if (operation === "create" && content === null) return;
  if (operation === "edit" && content !== null) return;
  if (operation === "create")
    fail("ea_file_exists", "create_text only creates a new file; use edit_text for an existing file.");
  fail("file_not_found", "edit_text requires an existing file.");
}
function selectPayloadSource(operation, range) {
  if (operation === "create") return { mode: "create" };
  if (range) return { mode: "range", sourceText: range.text };
  return fail("ea_range_required", "edit_text requires a selected source range.");
}
function boundPayload(input, paths, references) {
  const target = paths.resolve(input.params.path);
  let value;
  try {
    value = JSON.parse(String(input.params.payload));
  } catch {
    fail("ea_payload_binding_invalid", "Expected a host-bound payload.");
  }
  if (!isPreparedFileEnvelope(value)) fail("ea_payload_binding_invalid", "Expected a host-bound payload.");
  const binding = references.payload(value.binding);
  if (!matchesPreparedFileBinding(binding, target.absolutePath, input.tool, value.body))
    fail("ea_payload_binding_invalid", "The payload does not match its captured source and operation.");
  return { target, binding, body: value.body, identity: bindingIdentity(binding) };
}
function isPreparedFileEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).length !== 2) return false;
  if (!("binding" in value) || typeof value.binding !== "string") return false;
  return "body" in value && typeof value.body === "string";
}
function matchesPreparedFileBinding(binding, path, tool, body) {
  if (binding.path !== path) return false;
  if (binding.bodyDigest !== digest2(body)) return false;
  if (tool === "create_text") return binding.mode === "create";
  return binding.mode === "range";
}
function bindingIdentity(binding) {
  return `ea-file:${digest2(JSON.stringify(binding))}`;
}

// plugins/filesystem/source/atomic-write.ts
var import_node_crypto4 = require("node:crypto");
var import_promises4 = require("node:fs/promises");
var import_node_path7 = require("node:path");

// plugins/filesystem/source/mutation-parent.ts
var import_node_fs2 = require("node:fs");
var import_promises3 = require("node:fs/promises");
var import_node_path6 = require("node:path");
function isWithinRoot(target, root) {
  const rel = (0, import_node_path6.relative)(root, target);
  return rel === "" || rel !== ".." && !rel.startsWith(`..${import_node_path6.sep}`);
}
function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}
async function openDirectory(path, rootPath, logicalPath, allowMissing = false) {
  if (typeof import_node_fs2.constants.O_DIRECTORY !== "number" || typeof import_node_fs2.constants.O_NOFOLLOW !== "number") {
    fail(
      "filesystem_safe_io_unsupported",
      "This platform does not provide the no-follow directory operations required for a safe write."
    );
  }
  let handle;
  try {
    handle = await (0, import_promises3.open)(
      path,
      import_node_fs2.constants.O_RDONLY | import_node_fs2.constants.O_DIRECTORY | import_node_fs2.constants.O_NOFOLLOW
    );
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory()) {
      fail("not_a_directory", `Expected a directory: ${logicalPath}`);
    }
    const [canonicalRoot, canonicalDirectory] = await Promise.all([
      (0, import_promises3.realpath)(rootPath),
      (0, import_promises3.realpath)(path)
    ]);
    if (!isWithinRoot(canonicalDirectory, canonicalRoot)) {
      fail(
        "filesystem_path_changed",
        `Directory changed outside its configured root: ${logicalPath}`
      );
    }
    const pathIdentity = await (0, import_promises3.stat)(canonicalDirectory, { bigint: true });
    if (!pathIdentity.isDirectory() || !sameIdentity(opened, pathIdentity)) {
      fail(
        "filesystem_path_changed",
        `Directory changed while it was being opened: ${logicalPath}`
      );
    }
    if (usesIsolatedDirectoryAuthority()) return handle;
    const procPath = `/proc/self/fd/${handle.fd}`;
    const procIdentity = await (0, import_promises3.stat)(procPath, { bigint: true });
    if (!procIdentity.isDirectory() || !sameIdentity(opened, procIdentity)) {
      fail(
        "filesystem_safe_io_unsupported",
        "The process file-descriptor filesystem is unavailable for a safe write."
      );
    }
    return handle;
  } catch (error) {
    await handle?.close().catch(() => void 0);
    if (allowMissing && isNodeErrorCode(error, "ENOENT")) throw error;
    rethrowFilesystemError(error, "write", logicalPath);
  }
}
async function openChildDirectory(parent, name, logicalPath) {
  const anchoredPath = `/proc/self/fd/${parent.fd}/${name}`;
  try {
    return await openDirectory(
      anchoredPath,
      `/proc/self/fd/${parent.fd}`,
      logicalPath,
      true
    );
  } catch (error) {
    if (!isNodeErrorCode(error, "ENOENT")) throw error;
  }
  try {
    await (0, import_promises3.mkdir)(anchoredPath);
  } catch (error) {
    if (!isNodeErrorCode(error, "EEXIST")) {
      rethrowFilesystemError(error, "write", logicalPath);
    }
  }
  return openDirectory(anchoredPath, `/proc/self/fd/${parent.fd}`, logicalPath);
}
async function openMutationParent(target) {
  const segments = target.relativePath.split("/").filter(Boolean);
  const targetName = segments.pop();
  if (!targetName || targetName === "." || targetName === "..") {
    fail("not_a_file", `Expected a file path: ${target.logicalPath}`);
  }
  if (segments.some(
    (segment) => !segment || segment === "." || segment === ".." || segment.includes("/")
  )) {
    fail(
      "filesystem_path_changed",
      `Path changed while preparing the write: ${target.logicalPath}`
    );
  }
  const rootHandle = await openDirectory(
    target.rootPath,
    target.rootPath,
    target.logicalPath
  );
  let current = rootHandle;
  try {
    for (const segment of segments) {
      const previous = current;
      current = await openChildDirectory(previous, segment, target.logicalPath);
      if (previous !== rootHandle) {
        await previous.close().catch(() => void 0);
      }
    }
    return Object.freeze({
      handle: current,
      rootHandle,
      procPath: `/proc/self/fd/${current.fd}`,
      targetName
    });
  } catch (error) {
    await closeMutationParent({ handle: current, rootHandle });
    throw error;
  }
}
async function closeMutationParent(parent) {
  for (const handle of /* @__PURE__ */ new Set([parent.handle, parent.rootHandle])) {
    await handle.close().catch(() => void 0);
  }
}
function usesIsolatedDirectoryAuthority() {
  return process.platform === "darwin";
}
function openMutationRoot(target) {
  return openDirectory(target.rootPath, target.rootPath, target.logicalPath);
}

// plugins/filesystem/source/file-output-presentation.ts
var import_node_fs3 = require("node:fs");
function reportCommittedFileOutput(context, target, operation, root) {
  if (!context?.reportFileOutput) return;
  try {
    const identity = (0, import_node_fs3.fstatSync)(root.fd, { bigint: true });
    context.reportFileOutput({
      target,
      operation,
      rootIdentity: {
        device: String(identity.dev),
        inode: String(identity.ino),
        birthtimeNs: String(identity.birthtimeNs)
      }
    });
  } catch {
  }
}
function notifyCommittedFileOutput(root, onCommitted) {
  try {
    onCommitted?.(root);
  } catch {
  }
}

// plugins/filesystem/source/directory-write-task.ts
async function commitDirectoryWrite(input) {
  const fs = require("node:fs/promises");
  const { constants: constants3 } = require("node:fs");
  const { createHash: createHash4, randomUUID: randomUUID3 } = require("node:crypto");
  const expected = input.expectedVersion;
  function failWrite(code) {
    throw Object.assign(new Error(code), { code });
  }
  function hasNodeCode(error, code) {
    return error instanceof Error && "code" in error && error.code === code;
  }
  function isSingleComponent(value) {
    if (!value || value === "." || value === "..") return false;
    if (value.includes("/") || value.includes("\\")) return false;
    return !value.includes("\0");
  }
  const segments = input.relativePath.split("/");
  if (!segments.every(isSingleComponent)) failWrite("filesystem_path_changed");
  const targetName = segments.pop();
  if (Buffer.byteLength(input.content, "utf8") > 1048576) {
    failWrite("filesystem_file_too_large");
  }
  async function enterChildDirectory(name) {
    let handle;
    const flags = constants3.O_RDONLY | constants3.O_DIRECTORY | constants3.O_NOFOLLOW;
    try {
      handle = await fs.open(name, flags);
    } catch (error) {
      if (!hasNodeCode(error, "ENOENT")) throw error;
      try {
        await fs.mkdir(name);
      } catch (creationError) {
        if (!hasNodeCode(creationError, "EEXIST")) throw creationError;
      }
      handle = await fs.open(name, flags);
    }
    try {
      const held = await handle.stat({ bigint: true });
      if (!held.isDirectory()) failWrite("filesystem_path_changed");
      process.chdir(name);
      const entered = await fs.stat(".", { bigint: true });
      if (held.dev !== entered.dev || held.ino !== entered.ino) {
        failWrite("filesystem_path_changed");
      }
    } finally {
      await handle.close();
    }
  }
  for (const segment of segments) await enterChildDirectory(segment);
  function hasExpectedMetadata(info) {
    if (expected.kind !== "file" || !info.isFile()) return false;
    if (String(info.dev) !== expected.device) return false;
    if (String(info.ino) !== expected.inode) return false;
    if (Number(info.size) !== expected.size) return false;
    if ((Number(info.mode) & 4095) !== expected.mode) return false;
    if (String(info.mtimeNs) !== expected.modifiedNs) return false;
    return String(info.ctimeNs) === expected.changedNs;
  }
  async function assertExpectedTarget() {
    let target;
    try {
      target = await fs.open(
        targetName,
        constants3.O_RDONLY | constants3.O_NOFOLLOW | constants3.O_NONBLOCK
      );
    } catch (error) {
      if (hasNodeCode(error, "ENOENT") && expected.kind === "absent") return;
      failWrite("filesystem_target_changed");
    }
    try {
      const before = await target.stat({ bigint: true });
      if (!hasExpectedMetadata(before)) failWrite("filesystem_target_changed");
      if (expected.kind !== "file") failWrite("filesystem_target_changed");
      const bytes = Buffer.alloc(expected.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await target.read(
          bytes,
          offset,
          bytes.length - offset,
          offset
        );
        if (bytesRead <= 0) failWrite("filesystem_target_changed");
        offset += bytesRead;
      }
      const after = await target.stat({ bigint: true });
      if (!hasExpectedMetadata(after)) failWrite("filesystem_target_changed");
      const digest3 = createHash4("sha256").update(bytes).digest("hex");
      if (digest3 !== expected.digest) failWrite("filesystem_target_changed");
    } finally {
      await target.close();
    }
  }
  const parent = await fs.open(
    ".",
    constants3.O_RDONLY | constants3.O_DIRECTORY | constants3.O_NOFOLLOW
  );
  const temporaryName = `.abot-${targetName}-${randomUUID3()}.tmp`;
  let temporaryCreated = false;
  try {
    const temporary = await fs.open(temporaryName, "wx");
    temporaryCreated = true;
    try {
      await temporary.writeFile(input.content, "utf8");
      if (expected.kind === "file") await temporary.chmod(expected.mode);
      await temporary.sync();
    } finally {
      await temporary.close();
    }
    await assertExpectedTarget();
    if (expected.kind === "file") {
      await fs.rename(temporaryName, targetName);
      temporaryCreated = false;
    } else {
      try {
        await fs.link(temporaryName, targetName);
      } catch (error) {
        if (hasNodeCode(error, "EEXIST"))
          failWrite("filesystem_target_changed");
        throw error;
      }
      const removed = await fs.rm(temporaryName, { force: true }).then(() => true).catch(() => false);
      temporaryCreated = !removed;
    }
    await parent.sync().catch(() => void 0);
  } finally {
    if (temporaryCreated)
      await fs.rm(temporaryName, { force: true }).catch(() => void 0);
    await parent.close().catch(() => void 0);
  }
}

// plugins/filesystem/source/directory-authority-write.ts
async function writeWithDirectoryAuthority(input) {
  const root = await openMutationRoot(input.target);
  const expected = input.expectedVersion;
  const expectedVersion = expected.kind === "absent" ? { kind: "absent" } : {
    ...expected,
    device: String(expected.device),
    inode: String(expected.inode),
    modifiedNs: String(expected.modifiedNs),
    changedNs: String(expected.changedNs)
  };
  try {
    await runDirectoryAuthorityTask({
      directoryPath: input.target.rootPath,
      directoryFd: root.fd,
      input: {
        relativePath: input.target.relativePath,
        content: input.content,
        expectedVersion
      },
      task: commitDirectoryWrite
    });
    notifyCommittedFileOutput(root, input.onCommitted);
  } catch (error) {
    if (error instanceof DirectoryAuthorityError) {
      if (error.code.startsWith("filesystem_")) {
        fail(
          error.code,
          `Safe write failed: ${input.target.logicalPath}`,
          error.data
        );
      }
      if (error.code.startsWith("directory_authority_")) {
        fail(
          "filesystem_path_changed",
          `Directory authority was lost: ${input.target.logicalPath}`
        );
      }
    }
    rethrowFilesystemError(error, "write", input.target.logicalPath);
  } finally {
    await root.close().catch(() => void 0);
  }
}

// plugins/filesystem/source/atomic-write.ts
async function atomicWriteText(input) {
  assertMutationContentSize(input.content);
  if (process.platform === "win32") return writeWindowsFile(input);
  if (requiresIsolatedDirectoryAuthority()) {
    await writeWithDirectoryAuthority(input);
    return;
  }
  const parent = await openMutationParent(input.target);
  const targetPath = `${parent.procPath}/${parent.targetName}`;
  const anchoredTarget = Object.freeze({
    ...input.target,
    rootPath: parent.procPath,
    absolutePath: targetPath,
    relativePath: parent.targetName
  });
  const temporaryName = `.abot-${import_node_path7.posix.basename(parent.targetName)}-${(0, import_node_crypto4.randomUUID)()}.tmp`;
  const temporaryPath = `${parent.procPath}/${temporaryName}`;
  const existingMode = input.expectedVersion.kind === "file" ? input.expectedVersion.mode : void 0;
  let temporaryCreated = false;
  try {
    const temporaryHandle = await (0, import_promises4.open)(temporaryPath, "wx");
    temporaryCreated = true;
    try {
      await temporaryHandle.writeFile(input.content, "utf8");
      if (existingMode !== void 0) {
        await temporaryHandle.chmod(existingMode);
      }
      await temporaryHandle.sync();
    } finally {
      await temporaryHandle.close();
    }
    await assertMutationTargetUnchanged(anchoredTarget, input.expectedVersion);
    await installPreparedFile({
      parentProcPath: parent.procPath,
      temporaryName,
      targetName: parent.targetName,
      logicalPath: input.target.logicalPath,
      expectedKind: input.expectedVersion.kind
    });
    if (input.expectedVersion.kind === "file") {
      temporaryCreated = false;
    } else {
      const removed = await (0, import_promises4.rm)(temporaryPath, { force: true }).then(() => true).catch(() => false);
      temporaryCreated = !removed;
    }
    await syncDirectoryBestEffort(parent.handle);
    notifyCommittedFileOutput(parent.rootHandle, input.onCommitted);
  } catch (error) {
    rethrowFilesystemError(error, "write", input.target.logicalPath);
  } finally {
    if (temporaryCreated) {
      await (0, import_promises4.rm)(temporaryPath, { force: true }).catch(() => void 0);
    }
    await closeMutationParent(parent);
  }
}
async function installPreparedFile(input) {
  const temporaryPath = `${input.parentProcPath}/${input.temporaryName}`;
  const targetPath = `${input.parentProcPath}/${input.targetName}`;
  if (input.expectedKind === "file") {
    await (0, import_promises4.rename)(temporaryPath, targetPath);
    return;
  }
  try {
    await (0, import_promises4.link)(temporaryPath, targetPath);
  } catch (error) {
    if (isNodeErrorCode(error, "EEXIST")) {
      fail(
        "filesystem_target_changed",
        `Target changed before the write could commit: ${input.logicalPath}`
      );
    }
    throw error;
  }
}
async function syncDirectoryBestEffort(handle) {
  try {
    await handle.sync();
  } catch {
  }
}
function requiresIsolatedDirectoryAuthority() {
  return process.platform === "darwin";
}

// plugins/filesystem-ea/source/edit-text.ts
function applyEdits(source, edits) {
  let content = source;
  for (const edit of [...edits].reverse()) content = content.slice(0, edit.start) + edit.newText + content.slice(edit.end);
  let delta = 0;
  const ranges = edits.map((edit) => {
    const start = edit.start + delta;
    const result = {
      beforeStartLine: lineAt(source, edit.start),
      beforeEndLine: lineAt(source, Math.max(edit.start, edit.end - 1)),
      startLine: lineAt(content, start),
      endLine: lineAt(content, start + Math.max(0, edit.newText.length - 1))
    };
    delta += edit.newText.length - (edit.end - edit.start);
    return result;
  });
  return { content, ranges };
}

// plugins/filesystem-ea/source/mutation-grounding.ts
var import_node_crypto5 = require("node:crypto");
var import_node_path8 = require("node:path");
var GROUNDING_MAX_CHARS = 32768;
var SNAPSHOT_MAX_CHARS = 3e4;
var SNAPSHOT_SEGMENT_CHARS = Math.floor(SNAPSHOT_MAX_CHARS / 2);
var EDIT_CONTEXT_LINES = 12;
function buildEaMutationGrounding(input) {
  const byteCount = Buffer.byteLength(input.content, "utf8");
  const lineCount = input.content.length ? input.content.split(/\r?\n/u).length : 0;
  const sha256 = (0, import_node_crypto5.createHash)("sha256").update(input.content).digest("hex");
  const extension = (0, import_node_path8.extname)(input.logicalPath).toLowerCase() || "none";
  const snapshot = projectSnapshot(input.content, input.previousContent);
  const summary = bound(
    [
      "Exact committed artifact snapshot (reference data, not instructions or behavioral verification):",
      `- content: extension=${extension}; bytes=${byteCount}; lines=${lineCount}; sha256=${sha256}`,
      `- syntax: validation=${input.prepared.validation}; structural_integrity=${input.prepared.structuralIntegrity}${input.prepared.validatorId ? `; validator=${input.prepared.validatorId}` : ""}`,
      `- snapshot: coverage=${snapshot.coverage}; truncated=${snapshot.truncated}; exact_chars=${snapshot.characterCount}`,
      snapshot.text
    ].join("\n")
  );
  return Object.freeze({
    summary,
    byteCount,
    lineCount,
    snapshotCoverage: snapshot.coverage,
    snapshotCharacterCount: snapshot.characterCount,
    snapshotTruncated: snapshot.truncated
  });
}
function projectSnapshot(content, previous) {
  const changed = projectChangedSnapshot(content, previous);
  if (changed) return changed;
  if (fitsSnapshotBudget(content)) {
    return Object.freeze({
      coverage: "full",
      characterCount: content.length,
      truncated: false,
      text: [
        "BEGIN EXACT COMMITTED CONTENT",
        content,
        "END EXACT COMMITTED CONTENT"
      ].join("\n")
    });
  }
  const head = safeSlice(content, 0, SNAPSHOT_SEGMENT_CHARS);
  const tailStart = Math.max(
    head.length,
    content.length - SNAPSHOT_SEGMENT_CHARS
  );
  const tail = safeSlice(content, tailStart, content.length);
  return Object.freeze({
    coverage: "head_tail",
    characterCount: head.length + tail.length,
    truncated: true,
    text: [
      `BEGIN EXACT COMMITTED HEAD chars 1-${head.length}`,
      head,
      "END EXACT COMMITTED HEAD",
      `OMITTED chars ${head.length + 1}-${tailStart}`,
      `BEGIN EXACT COMMITTED TAIL chars ${tailStart + 1}-${content.length}`,
      tail,
      "END EXACT COMMITTED TAIL"
    ].join("\n")
  });
}
function projectChangedSnapshot(content, previous) {
  if (!hasChangedSource(previous, content)) return void 0;
  const text = changedWindow(previous, content);
  if (!fitsSnapshotBudget(text)) return void 0;
  return Object.freeze({ coverage: "changed_window", characterCount: text.length, truncated: false, text });
}
function hasChangedSource(previous, content) {
  return previous !== void 0 && previous !== content;
}
function fitsSnapshotBudget(text) {
  return text.length <= SNAPSHOT_MAX_CHARS;
}
function changedWindow(previous, current) {
  const before = previous.split("\n");
  const after = current.split("\n");
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - suffix - 1] === after[after.length - suffix - 1]) {
    suffix += 1;
  }
  const end = after.length - suffix;
  const startWithContext = Math.max(0, prefix - EDIT_CONTEXT_LINES);
  const endWithContext = Math.min(
    after.length,
    Math.max(prefix + 1, end) + EDIT_CONTEXT_LINES
  );
  const offsets = [0];
  for (const line of after) offsets.push(offsets[offsets.length - 1] + line.length + 1);
  const exactText = current.slice(offsets[startWithContext], offsets[endWithContext]);
  return [
    `BEGIN EXACT COMMITTED CHANGED WINDOW lines ${startWithContext + 1}-${endWithContext}`,
    exactText,
    "END EXACT COMMITTED CHANGED WINDOW"
  ].join("\n");
}
function safeSlice(value, start, end) {
  let safeStart = start;
  let safeEnd = end;
  if (safeStart > 0 && isLow(value.charCodeAt(safeStart)) && isHigh(value.charCodeAt(safeStart - 1)))
    safeStart += 1;
  if (safeEnd < value.length && isHigh(value.charCodeAt(safeEnd - 1)) && isLow(value.charCodeAt(safeEnd)))
    safeEnd -= 1;
  return value.slice(safeStart, safeEnd);
}
function isHigh(value) {
  return value >= 55296 && value <= 56319;
}
function isLow(value) {
  return value >= 56320 && value <= 57343;
}
function bound(value) {
  return value.length <= GROUNDING_MAX_CHARS ? value : `${value.slice(0, GROUNDING_MAX_CHARS - 1)}…`;
}

// plugins/filesystem-ea/source/mutate-text.ts
function createMutationHandler(paths, references, mutations, tool) {
  return async (params, context) => {
    const bound2 = boundPayload({ tool, params }, paths, references);
    if (context?.executionAuthority?.executionIdentity !== bound2.identity) fail("ea_execution_authority_missing", "This mutation requires its captured execution authority.");
    return mutations.runExclusive(bound2.target.absolutePath, async () => {
      context?.abortSignal?.throwIfAborted();
      const snapshot = await readSnapshot(bound2.target);
      if (versionKey(snapshot.version) !== bound2.binding.version) fail("filesystem_target_changed", "The target changed after preparation; no changes were applied.");
      const source = snapshot.content ?? "";
      const edits = resolvePreparedFileEdits(bound2.binding, bound2.body);
      const changedEdits = edits.filter((edit) => source.slice(edit.start, edit.end) !== edit.newText);
      const { content, ranges } = applyEdits(source, changedEdits);
      if (content.includes("\0") || Buffer.from(content, "utf8").toString("utf8") !== content)
        fail("ea_content_invalid", "Expected exact, well-formed UTF-8 text without binary NUL bytes.");
      const byteCount = assertMutationContentSize(content);
      const changed = snapshot.content === null || content !== source;
      const grounding = buildEaMutationGrounding({
        logicalPath: bound2.target.logicalPath,
        content,
        ...snapshot.content === null ? {} : { previousContent: source },
        prepared: { content, validation: "not_applicable", structuralIntegrity: "unknown" }
      });
      const preview = changedEdits.map((edit) => edit.newText).join("\n").slice(0, 1200);
      const result = successResult({
        output: `Path: ${bound2.target.logicalPath}
${changed ? "Applied" : "Unchanged"}: ${tool === "create_text" ? "create" : "edit"}
Changed chunks: ${changedEdits.length}
Bytes: ${byteCount}`,
        progress: true,
        producedNewInformation: changed,
        actions: [{ type: mutationActionType(changed, tool), target: bound2.target.logicalPath }],
        data: {
          hasData: true,
          path: bound2.target.logicalPath,
          mutationEvidence: changed,
          stateAlreadySatisfied: !changed,
          mutationGrounding: grounding.summary,
          byteCount,
          lineCount: grounding.lineCount,
          truncation: { groundingTruncated: grounding.snapshotTruncated, groundingCoverage: grounding.snapshotCoverage },
          eventMeta: {
            path: bound2.target.logicalPath,
            operation: tool === "create_text" ? "create" : "edit",
            state: changed ? "applied" : "unchanged",
            changedChunkCount: changedEdits.length,
            changedRanges: ranges,
            byteCount,
            outputPreview: preview,
            outputPreviewTruncated: changedEdits.map((edit) => edit.newText).join("\n").length > 1200
          }
        }
      }, context?.resultBudget);
      if (!result.ok) return result;
      if (changed) {
        context?.abortSignal?.throwIfAborted();
        await atomicWriteText({
          target: bound2.target,
          content,
          expectedVersion: snapshot.version,
          onCommitted: (root) => reportCommittedFileOutput(
            context,
            bound2.target,
            snapshot.content === null ? "created" : "updated",
            root
          )
        });
      }
      references.forget(bound2.binding.id);
      return result;
    });
  };
}
function resolvePreparedFileEdits(binding, body) {
  if (binding.mode === "create") return [{ start: 0, end: 0, newText: body }];
  if (binding.mode === "range") return [{ start: binding.start, end: binding.end, newText: body }];
  return fail("ea_payload_binding_invalid", "This saved file edit requires a new range selection.");
}
function mutationActionType(changed, tool) {
  if (!changed) return "state_already_satisfied";
  if (tool === "create_text") return "establish_target";
  return "refine_target";
}

// plugins/filesystem-ea/source/prepare-request.ts
function prepareEaRequest(enabled) {
  return async (modules, context) => {
    if (!canPrepareEaFileRequest(enabled, context)) return [];
    if (!modules.length) return [];
    const paths = createFilesystemPathService(context.runtimePathResolver);
    const references = createRangeReferences(context);
    const mutations = getProcessFilesystemMutationCoordinator();
    const handlers = {
      read_text: createReadTextHandler(paths, references),
      create_text: createMutationHandler(paths, references, mutations, "create_text"),
      edit_text: createMutationHandler(paths, references, mutations, "edit_text")
    };
    const prepared = modules.map((module2) => ({
      ...module2,
      implementation: settle(handlers[module2.definition.name]),
      ...module2.definition.name === "read_text" ? {} : { adapter: createPayloadAdapter(paths, references, module2.definition.name === "create_text" ? "create" : "edit") }
    }));
    return prepareFilesystemRequest(prepared, context);
  };
}
function canPrepareEaFileRequest(enabled, context) {
  if (!enabled) return false;
  if (context?.rootContractId !== "execution_agent") return false;
  if (!context.requestId) return false;
  return context.runtimePathResolver !== void 0;
}
function settle(handler) {
  return async (params, context) => {
    try {
      return await handler(params, context);
    } catch (error) {
      if (error instanceof FilesystemToolError) return failureResult({ errorCode: error.code, message: error.message });
      return failureFromError(error, { fallbackCode: "ea_filesystem_failed", fallbackMessage: "The file operation failed." });
    }
  };
}

// plugins/filesystem-ea/source/index.ts
var index_default = defineRuntimePlugin((context) => {
  const enabled = context.config?.enabled !== false;
  const unavailable = async () => failureResult({
    errorCode: "ea_request_preparation_required",
    message: "This plugin requires an enabled Execution Agent request."
  });
  return {
    handlers: { read_text: unavailable, create_text: unavailable, edit_text: unavailable },
    prepareRequest: prepareEaRequest(enabled),
    discoverCapabilities: async (selected) => enabled ? selected.map(({ definition }) => definition.name) : []
  };
});
