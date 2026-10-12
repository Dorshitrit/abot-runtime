// GENERATED FILE - DO NOT EDIT.
// Source: plugins/document-reader/source/index.ts
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

// src/plugin-sdk/files-windows/read-script.ts
var BOUNDED_READ, WINDOWS_BOUNDED_READ_SOURCE;
var init_read_script = __esm({
  "src/plugin-sdk/files-windows/read-script.ts"() {
    "use strict";
    init_native_script();
    init_authority_script();
    init_read_bytes_script();
    BOUNDED_READ = String.raw`
public static partial class AbotFilesystem {
  static object ReadBounded(Dictionary<string,object> request) {
    long maximum;
    if (!Int64.TryParse(Text(request, "maxBytes"), out maximum) || maximum < 0 ||
        maximum > 9007199254740991L) throw new FsFault("filesystem_invalid_request");
    string[] parts=Components(request);
    if (parts.Length == 0) return Record("ok", false, "reason", "not_regular_file");
    using (var chain=new DirectoryChain(request)) {
      chain.Walk(parts, parts.Length-1, false);
      using (var file=OpenHandle(chain.Current, parts[parts.Length-1], false, 1, 0x80000000, 1)) {
        var expected=request["targetIdentity"] as Dictionary<string,object>;
        if (expected == null || !MatchesIdentity(Identity(file), expected))
          return Record("ok", false, "reason", "changed_during_read");
        var before=Metadata(file);
        long size=Convert.ToInt64(before["size"]);
        // Both the byte array and the base64 JSON response must fit .NET strings.
        if (size > maximum || size > (Int32.MaxValue-4096L)/4*3)
          return Record("ok", false, "reason", "too_large", "byteCount", size);
        var bytes=ReadBytes(file, 0, (int)size);
        if (!SameMetadata(before, Metadata(file)))
          return Record("ok", false, "reason", "changed_during_read");
        return Record("ok", true, "bytes", Convert.ToBase64String(bytes), "byteCount", size);
      }
    }
  }
  public static string Run(string input) {
    var json=new JavaScriptSerializer { MaxJsonLength=Int32.MaxValue };
    try { return json.Serialize(ReadBounded(json.Deserialize<Dictionary<string,object>>(input))); }
    catch (FsFault error) { return json.Serialize(Record("ok", false, "code", error.Code)); }
    catch { return json.Serialize(Record("ok", false, "code", "filesystem_native_operation_failed")); }
  }
}
`;
    WINDOWS_BOUNDED_READ_SOURCE = [
      WINDOWS_FILESYSTEM_NATIVE,
      WINDOWS_FILESYSTEM_AUTHORITY,
      WINDOWS_FILE_READ_BYTES,
      BOUNDED_READ
    ].join("\n");
  }
});

// src/plugin-sdk/files-windows/result.ts
function windowsReadError(code) {
  const error = new Error(
    "The Windows safe file read failed (" + code + "). No fallback read was attempted."
  );
  return Object.assign(error, { code });
}
function windowsReadAbortError() {
  const error = new Error("The file read was cancelled.");
  error.name = "AbortError";
  return error;
}
function hasByteCount(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function decodeNativeFailure(code) {
  switch (code) {
    case "filesystem_windows_policy_blocked":
    case "filesystem_windows_helper_unavailable":
    case "filesystem_safe_io_unsupported":
      return Object.freeze({ ok: false, reason: "safe_open_unsupported" });
    case "filesystem_path_changed":
    case "filesystem_target_changed":
    case "filesystem_read_changed":
    case "filesystem_read_incomplete":
      return Object.freeze({ ok: false, reason: "changed_during_read" });
    case "file_too_large":
      return Object.freeze({ ok: false, reason: "too_large" });
    case "file_not_found":
      throw windowsReadError("ENOENT");
    case "filesystem_access_denied":
      throw windowsReadError("EACCES");
    default:
      throw windowsReadError("EIO");
  }
}
function decodeWindowsReadResult(raw, maxBytes) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw windowsReadError("EIO");
  }
  if (value?.ok === false && typeof value.code === "string")
    return decodeNativeFailure(value.code);
  if (value?.ok === false && FAILURE_REASONS.has(value.reason)) {
    if (value.byteCount !== void 0 && !hasByteCount(value.byteCount))
      throw windowsReadError("EIO");
    return Object.freeze({
      ok: false,
      reason: value.reason,
      ...value.byteCount !== void 0 ? { byteCount: value.byteCount } : {}
    });
  }
  if (value?.ok !== true || !hasByteCount(value.byteCount))
    throw windowsReadError("EIO");
  if (value.byteCount > maxBytes || typeof value.bytes !== "string")
    throw windowsReadError("EIO");
  if (value.bytes.length !== 4 * Math.ceil(value.byteCount / 3))
    throw windowsReadError("EIO");
  const bytes = Buffer.from(value.bytes, "base64");
  if (bytes.length !== value.byteCount || bytes.toString("base64") !== value.bytes)
    throw windowsReadError("EIO");
  return Object.freeze({ ok: true, bytes, byteCount: value.byteCount });
}
var FAILURE_REASONS;
var init_result = __esm({
  "src/plugin-sdk/files-windows/result.ts"() {
    "use strict";
    FAILURE_REASONS = /* @__PURE__ */ new Set([
      "not_regular_file",
      "too_large",
      "changed_during_read",
      "outside_root",
      "safe_open_unsupported"
    ]);
  }
});

// src/plugin-sdk/files-windows/process.ts
async function runWindowsBoundedRead(request, maxBytes, signal, spawnProcess = import_node_child_process.spawn) {
  if (signal?.aborted) throw windowsReadAbortError();
  const input = JSON.stringify({
    source: WINDOWS_BOUNDED_READ_SOURCE,
    request: JSON.stringify(request)
  });
  if (Buffer.byteLength(input) > 2 * 1024 * 1024)
    throw windowsReadError("EINVAL");
  const outputLimit = 4 * Math.ceil(Math.min(maxBytes, 2147483647) / 3) + 4096;
  const executable = (0, import_node_path.join)(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  return new Promise((resolve, reject) => {
    const child = spawnProcess(
      executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", BOOTSTRAP],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
    );
    const chunks = [];
    let byteCount = 0;
    let failure;
    let unavailable = false;
    const stop = (error) => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const abort = () => stop(windowsReadAbortError());
    const timer = setTimeout(() => stop(windowsReadError("ETIMEDOUT")), 15e3);
    timer.unref();
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      if (failure) return;
      byteCount += chunk.length;
      if (byteCount > outputLimit) {
        stop(windowsReadError("EOVERFLOW"));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on("error", () => {
      if (child.pid === void 0) return;
      stop(windowsReadError("EIO"));
    });
    child.once("error", () => {
      if (child.pid === void 0) {
        unavailable = true;
        return;
      }
      stop(windowsReadError("EIO"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure) {
        reject(failure);
        return;
      }
      if (unavailable) {
        resolve(UNAVAILABLE);
        return;
      }
      if (code !== 0) {
        reject(windowsReadError("EIO"));
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
}
var import_node_child_process, import_node_path, BOOTSTRAP, UNAVAILABLE;
var init_process = __esm({
  "src/plugin-sdk/files-windows/process.ts"() {
    "use strict";
    import_node_child_process = require("node:child_process");
    import_node_path = require("node:path");
    init_read_script();
    init_result();
    BOOTSTRAP = [
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
      `} catch { if ($started) { [Console]::Write('{"ok":false,"code":"filesystem_native_operation_failed"}') } else { [Console]::Write('{"ok":false,"code":"filesystem_windows_helper_unavailable"}') } }`
    ].join(";");
    UNAVAILABLE = '{"ok":false,"code":"filesystem_windows_helper_unavailable"}';
  }
});

// src/plugin-sdk/files-windows/read.ts
var read_exports = {};
__export(read_exports, {
  readWindowsBoundedRegularFile: () => readWindowsBoundedRegularFile
});
function isOutsideRoot(rootRelative) {
  if (import_node_path2.win32.isAbsolute(rootRelative)) return true;
  if (rootRelative === "..") return true;
  return rootRelative.startsWith("..\\");
}
function identity(stats) {
  return {
    device: String(stats.dev),
    inode: String(stats.ino),
    birthtimeNs: String(stats.birthtimeNs)
  };
}
async function readWindowsBoundedRegularFile(absolutePath, options) {
  const relativePath = import_node_path2.win32.relative(options.rootPath, absolutePath);
  if (isOutsideRoot(relativePath)) return Object.freeze({ ok: false, reason: "outside_root" });
  if (relativePath === "") return Object.freeze({ ok: false, reason: "not_regular_file" });
  let root;
  try {
    const canonicalRoot = await (0, import_promises.realpath)(options.rootPath);
    root = await (0, import_promises.open)(canonicalRoot, "r");
    const rootStats = await root.stat({ bigint: true });
    if (!rootStats.isDirectory() || rootStats.ino <= 0n)
      return Object.freeze({ ok: false, reason: "safe_open_unsupported" });
    const targetPath = import_node_path2.win32.resolve(canonicalRoot, relativePath);
    const target = await (0, import_promises.lstat)(targetPath, { bigint: true });
    if (!target.isFile()) return Object.freeze({ ok: false, reason: "not_regular_file" });
    const canonicalTarget = await (0, import_promises.realpath)(targetPath);
    if (isOutsideRoot(import_node_path2.win32.relative(canonicalRoot, canonicalTarget)))
      return Object.freeze({ ok: false, reason: "outside_root" });
    if (options.signal?.aborted) throw windowsReadAbortError();
    const raw = await runWindowsBoundedRead({
      rootPath: canonicalRoot,
      relativePath: relativePath.split(import_node_path2.win32.sep).join("/"),
      rootIdentity: identity(rootStats),
      targetIdentity: identity(target),
      maxBytes: String(options.maxBytes)
    }, options.maxBytes, options.signal);
    if (options.signal?.aborted) throw windowsReadAbortError();
    return decodeWindowsReadResult(raw, options.maxBytes);
  } finally {
    await root?.close();
  }
}
var import_promises, import_node_path2;
var init_read = __esm({
  "src/plugin-sdk/files-windows/read.ts"() {
    "use strict";
    import_promises = require("node:fs/promises");
    import_node_path2 = require("node:path");
    init_process();
    init_result();
  }
});

// plugins/document-reader/source/index.ts
var index_exports = {};
__export(index_exports, {
  default: () => index_default
});
module.exports = __toCommonJS(index_exports);

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
var import_promises2 = require("node:fs/promises");
var import_node_path3 = require("node:path");
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
  if (process.platform === "win32") {
    const { readWindowsBoundedRegularFile: readWindowsBoundedRegularFile2 } = await Promise.resolve().then(() => (init_read(), read_exports));
    return readWindowsBoundedRegularFile2(absolutePath, options);
  }
  if (typeof import_node_fs.constants.O_NOFOLLOW !== "number") {
    return Object.freeze({ ok: false, reason: "safe_open_unsupported" });
  }
  let handle;
  try {
    handle = await (0, import_promises2.open)(
      absolutePath,
      import_node_fs.constants.O_RDONLY | import_node_fs.constants.O_NOFOLLOW
    );
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      return Object.freeze({ ok: false, reason: "not_regular_file" });
    }
    const [canonicalRoot, canonicalTarget] = await Promise.all([
      (0, import_promises2.realpath)(options.rootPath),
      (0, import_promises2.realpath)(absolutePath)
    ]);
    const rootRelative = (0, import_node_path3.relative)(canonicalRoot, canonicalTarget);
    if (rootRelative === ".." || rootRelative.startsWith(`..${import_node_path3.sep}`) || rootRelative.startsWith(import_node_path3.sep)) {
      return Object.freeze({ ok: false, reason: "outside_root" });
    }
    const pathIdentity = await (0, import_promises2.stat)(canonicalTarget, { bigint: true });
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

// plugins/document-reader/source/constants.ts
var MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
var DEFAULT_MAX_CHARS = 2e4;
var MAX_CHARS = 4e4;
var MAX_START_CHAR = 1e7;
var MAX_RETAINED_TEXT_CHARS = MAX_START_CHAR + MAX_CHARS;
var MAX_OUTPUT_CHARS = 48e3;
var MAX_OUTPUT_JSON_BYTES = 64 * 1024;
var MAX_IDENTITY_CHARS = 512;
var MAX_ARCHIVE_ENTRIES = 4096;
var MAX_ARCHIVE_DECLARED_BYTES = 256 * 1024 * 1024;
var MAX_XML_ENTRY_BYTES = 8 * 1024 * 1024;
var MAX_TOTAL_XML_BYTES = 24 * 1024 * 1024;
var MAX_PDF_PAGES = 1e4;
var PDF_PAGE_BATCH_SIZE = 1;
var PDF_EXTRACTION_TIMEOUT_MS = 3e4;
var PDF_MAX_OLD_GENERATION_MB = 128;
var PDF_MAX_YOUNG_GENERATION_MB = 16;
var PDF_MAX_STACK_MB = 4;
var MAX_PDF_ERROR_MESSAGE_CHARS = 512;
var EXTENSION_MIME_TYPES = Object.freeze({
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".json": "application/json",
  ".rtf": "application/rtf"
});
var MIME_TYPE_ALIASES = Object.freeze({
  "application/x-rtf": "application/rtf",
  "text/rtf": "application/rtf",
  "text/x-markdown": "text/markdown"
});

// plugins/document-reader/source/errors.ts
var DocumentReaderError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "DocumentReaderError";
    this.code = code;
  }
};
function failDocument(code, message) {
  throw new DocumentReaderError(code, message);
}
function hasNodeErrorCode(error, code) {
  return error instanceof Error && typeof error.code === "string" && error.code === code;
}
function rethrowDocumentIoError(error) {
  if (error instanceof DocumentReaderError) throw error;
  if (hasNodeErrorCode(error, "ENOENT")) {
    failDocument(
      "document_not_found",
      "The requested document does not exist."
    );
  }
  if (hasNodeErrorCode(error, "EACCES") || hasNodeErrorCode(error, "EPERM")) {
    failDocument(
      "document_access_denied",
      "Access to the requested document was denied."
    );
  }
  if (hasNodeErrorCode(error, "EISDIR")) {
    failDocument(
      "document_target_not_file",
      "The requested document is not a regular file."
    );
  }
  if (hasNodeErrorCode(error, "ABORT_ERR") || error instanceof Error && error.name === "AbortError") {
    failDocument("document_read_cancelled", "Document reading was cancelled.");
  }
  throw error;
}
function documentReaderFailure(error) {
  if (error instanceof DocumentReaderError) {
    return failureResult({
      errorCode: error.code,
      message: error.message,
      output: `read_document failed: ${error.message}`
    });
  }
  return failureFromError(error, {
    fallbackCode: "document_read_failed",
    fallbackMessage: "Document reading failed.",
    operation: "read_document"
  });
}

// plugins/document-reader/source/pdf-worker.ts
var import_node_module = require("node:module");
var import_node_worker_threads = require("node:worker_threads");

// plugins/document-reader/source/pdf-contract.ts
var PDF_EXTRACTION_LIMITS = Object.freeze({
  maxPages: MAX_PDF_PAGES,
  pageBatchSize: PDF_PAGE_BATCH_SIZE,
  maxRetainedCharacters: MAX_RETAINED_TEXT_CHARS,
  timeoutMs: PDF_EXTRACTION_TIMEOUT_MS,
  maxOldGenerationSizeMb: PDF_MAX_OLD_GENERATION_MB,
  maxYoungGenerationSizeMb: PDF_MAX_YOUNG_GENERATION_MB,
  stackSizeMb: PDF_MAX_STACK_MB
});

// plugins/document-reader/source/pdf-parser.ts
async function runPdfParser(data, publish) {
  const fail = (code, message) => {
    const error = new Error(message);
    error.code = code;
    throw error;
  };
  const boundedMessage = (value) => {
    const message = value instanceof Error ? value.message : String(value);
    return message.slice(0, data.limits.maxErrorMessageCharacters);
  };
  let parser;
  try {
    const { PDFParse } = require(data.pdfParseEntrypoint);
    parser = new PDFParse({
      data: new Uint8Array(data.bytes),
      isEvalSupported: false,
      stopAtErrors: true
    });
    const info = await parser.getInfo();
    const totalPages = info.total;
    if (!Number.isSafeInteger(totalPages) || totalPages < 0) {
      fail("document_content_invalid", "The PDF page index is invalid.");
    }
    if (totalPages > data.limits.maxPages) {
      fail(
        "document_pdf_page_limit",
        `The PDF exceeds the ${data.limits.maxPages}-page parsing limit.`
      );
    }
    const retainedParts = [];
    let retainedCharacters = 0;
    let totalCharacters = 0;
    let processedPages = 0;
    let hasContent = false;
    const append = (rawValue) => {
      const value = rawValue.replaceAll("\0", "").trim();
      if (value.length === 0) return;
      const separator = hasContent ? "\n\n" : "";
      hasContent = true;
      const nextTotal = totalCharacters + separator.length + value.length;
      if (!Number.isSafeInteger(nextTotal)) {
        fail(
          "document_pdf_resource_limit",
          "The PDF text exceeds the supported character range."
        );
      }
      totalCharacters = nextTotal;
      let remaining = data.limits.maxRetainedCharacters - retainedCharacters;
      if (remaining <= 0) return;
      if (separator.length > 0) {
        const retainedSeparator = separator.slice(0, remaining);
        retainedParts.push(retainedSeparator);
        retainedCharacters += retainedSeparator.length;
        remaining -= retainedSeparator.length;
      }
      if (remaining > 0) {
        const retainedValue = value.slice(0, remaining);
        retainedParts.push(retainedValue);
        retainedCharacters += retainedValue.length;
      }
    };
    for (let firstPage = 1; firstPage <= totalPages; firstPage += data.limits.pageBatchSize) {
      const pageNumbers = Array.from(
        {
          length: Math.min(
            data.limits.pageBatchSize,
            totalPages - firstPage + 1
          )
        },
        (_, index) => firstPage + index
      );
      const batch = await parser.getText({
        partial: pageNumbers,
        pageJoiner: ""
      });
      if (!Array.isArray(batch.pages)) {
        fail(
          "document_content_invalid",
          "The PDF page set could not be extracted."
        );
      }
      for (const page of batch.pages) {
        if (typeof page?.text !== "string") {
          fail("document_content_invalid", "The PDF page text is invalid.");
        }
        processedPages += 1;
        append(page.text);
      }
    }
    if (processedPages !== totalPages) {
      fail(
        "document_content_invalid",
        "The PDF page set could not be extracted completely."
      );
    }
    publish({
      kind: "success",
      text: retainedParts.join(""),
      totalCharacters,
      returnedCharacters: retainedCharacters,
      totalPages,
      processedPages
    });
  } catch (error) {
    const candidateCode = error instanceof Error && typeof error.code === "string" ? error.code : void 0;
    publish({
      kind: "failure",
      ...candidateCode ? { code: candidateCode } : {},
      message: boundedMessage(error)
    });
  } finally {
    if (parser) {
      await parser.destroy().catch(() => void 0);
    }
  }
}

// plugins/document-reader/source/pdf-result.ts
var CONTROLLED_PDF_ERROR_CODES = /* @__PURE__ */ new Set([
  "document_content_invalid",
  "document_pdf_page_limit",
  "document_pdf_resource_limit"
]);
function isSafeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}
function isPdfWorkerMessage(value) {
  if (!value || typeof value !== "object") return false;
  const candidate = value;
  if (candidate.kind === "failure") {
    return typeof candidate.message === "string" && candidate.message.length <= MAX_PDF_ERROR_MESSAGE_CHARS && (candidate.code === void 0 || typeof candidate.code === "string");
  }
  return candidate.kind === "success" && typeof candidate.text === "string" && isSafeNonNegativeInteger(candidate.totalCharacters) && isSafeNonNegativeInteger(candidate.returnedCharacters) && isSafeNonNegativeInteger(candidate.totalPages) && isSafeNonNegativeInteger(candidate.processedPages);
}
function isBoundedPdfSuccess(message, limits) {
  if (message.text.length !== message.returnedCharacters) return false;
  if (message.returnedCharacters > limits.maxRetainedCharacters) return false;
  if (message.returnedCharacters > message.totalCharacters) return false;
  if (message.totalPages > limits.maxPages) return false;
  return message.processedPages === message.totalPages;
}
function documentFromPdfMessage(message, limits) {
  if (!isPdfWorkerMessage(message)) {
    throw new Error("PDF extraction worker returned invalid data.");
  }
  if (message.kind === "failure") {
    if (message.code && CONTROLLED_PDF_ERROR_CODES.has(message.code)) {
      throw new DocumentReaderError(message.code, message.message);
    }
    throw new Error(message.message);
  }
  if (!isBoundedPdfSuccess(message, limits)) {
    throw new Error("PDF extraction worker exceeded its contract.");
  }
  return Object.freeze({
    text: message.text,
    textBounds: Object.freeze({
      truncated: message.totalCharacters > message.returnedCharacters,
      totalCharacters: message.totalCharacters,
      returnedCharacters: message.returnedCharacters,
      omittedCharacters: message.totalCharacters - message.returnedCharacters,
      maxCharacters: limits.maxRetainedCharacters
    }),
    format: Object.freeze({
      kind: "pdf",
      totalPages: message.totalPages,
      processedPages: message.processedPages,
      maxPages: limits.maxPages
    })
  });
}

// plugins/document-reader/source/pdf-worker.ts
function resolvePdfParseEntrypoint(pluginEntrypoint) {
  return (0, import_node_module.createRequire)(pluginEntrypoint).resolve("pdf-parse");
}
function createPdfExtractionWorker(bytes, pdfParseEntrypoint, limits = PDF_EXTRACTION_LIMITS) {
  const transferredBytes = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(transferredBytes).set(bytes);
  return new import_node_worker_threads.Worker(
    `const { parentPort, workerData } = require("node:worker_threads");
    void (${runPdfParser.toString()})(workerData, message => parentPort.postMessage(message))
      .finally(() => parentPort.close());`,
    {
      eval: true,
      transferList: [transferredBytes],
      workerData: {
        bytes: transferredBytes,
        pdfParseEntrypoint,
        limits: {
          maxPages: limits.maxPages,
          pageBatchSize: limits.pageBatchSize,
          maxRetainedCharacters: limits.maxRetainedCharacters,
          maxErrorMessageCharacters: MAX_PDF_ERROR_MESSAGE_CHARS
        }
      },
      resourceLimits: {
        maxOldGenerationSizeMb: limits.maxOldGenerationSizeMb,
        maxYoungGenerationSizeMb: limits.maxYoungGenerationSizeMb,
        stackSizeMb: limits.stackSizeMb
      }
    }
  );
}
function resourceLimitError(message) {
  return new DocumentReaderError("document_pdf_resource_limit", message);
}
async function extractPdfInWorker(bytes, params) {
  const limits = params.limits ?? PDF_EXTRACTION_LIMITS;
  if (params.signal?.aborted) {
    throw new DocumentReaderError(
      "document_read_cancelled",
      "Document reading was cancelled."
    );
  }
  const worker = createPdfExtractionWorker(
    bytes,
    params.pdfParseEntrypoint,
    limits
  );
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settle(
        () => reject(
          resourceLimitError(
            `PDF extraction exceeded the ${limits.timeoutMs}-millisecond time limit.`
          )
        ),
        true
      );
    }, limits.timeoutMs);
    timeout.unref();
    const cleanup = () => {
      clearTimeout(timeout);
      params.signal?.removeEventListener("abort", onAbort);
      worker.removeAllListeners();
    };
    const settle = (complete, terminate) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminate) void worker.terminate();
      complete();
    };
    const onAbort = () => {
      settle(
        () => reject(
          new DocumentReaderError(
            "document_read_cancelled",
            "Document reading was cancelled."
          )
        ),
        true
      );
    };
    worker.once("message", (message) => {
      settle(() => {
        try {
          resolve(documentFromPdfMessage(message, limits));
        } catch (error) {
          reject(error);
        }
      }, true);
    });
    worker.once("error", (error) => {
      settle(
        () => reject(
          error.code === "ERR_WORKER_OUT_OF_MEMORY" ? resourceLimitError("PDF extraction exceeded the memory limit.") : error
        ),
        false
      );
    });
    worker.once("exit", (code) => {
      if (code === 0) {
        settle(
          () => reject(new Error("PDF extraction worker exited without a result.")),
          false
        );
        return;
      }
      settle(
        () => reject(
          resourceLimitError(
            "PDF extraction stopped after exceeding a resource limit."
          )
        ),
        false
      );
    });
    params.signal?.addEventListener("abort", onAbort, { once: true });
    if (params.signal?.aborted) onAbort();
  });
}

// plugins/document-reader/source/read-failure.ts
function failDocumentRead(file, maxBytes) {
  switch (file.reason) {
    case "not_regular_file":
      return failDocument(
        "document_target_not_file",
        "The requested document is not a regular file."
      );
    case "too_large":
      return failDocument(
        "document_file_too_large",
        "The requested document exceeds the " + maxBytes + "-byte parsing limit."
      );
    case "outside_root":
      return failDocument(
        "document_outside_root",
        "The requested document resolves outside its authorized root. Do not retry this target or bypass the path restriction."
      );
    case "safe_open_unsupported":
      return failDocument(
        "document_safe_read_unavailable",
        "Safe file reading is unavailable on this system. On Windows, computer policy may block the required PowerShell/C# helper. Do not retry or bypass this restriction with another tool; ask the user to check the system requirements or contact their administrator."
      );
    case "changed_during_read":
      return failDocument(
        "document_changed_during_read",
        "The requested document changed while it was being read."
      );
  }
}

// plugins/document-reader/source/archive.ts
var import_jszip = __toESM(require("jszip"), 1);
var END_OF_CENTRAL_DIRECTORY_SIGNATURE = 101010256;
var CENTRAL_DIRECTORY_ENTRY_SIGNATURE = 33639248;
var MAX_END_RECORD_SEARCH_BYTES = 65557;
function findEndOfCentralDirectory(bytes, view) {
  if (bytes.byteLength < 22) {
    failDocument("document_archive_invalid", "The OOXML archive is invalid.");
  }
  const minimumOffset = Math.max(
    0,
    bytes.byteLength - MAX_END_RECORD_SEARCH_BYTES
  );
  for (let offset = bytes.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (view.getUint32(offset, true) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      continue;
    }
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength === bytes.byteLength) return offset;
  }
  failDocument("document_archive_invalid", "The OOXML archive is invalid.");
}
function validateArchiveDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = findEndOfCentralDirectory(bytes, view);
  const entryCount = view.getUint16(endOffset + 10, true);
  const diskEntryCount = view.getUint16(endOffset + 8, true);
  const directoryBytes = view.getUint32(endOffset + 12, true);
  const directoryOffset = view.getUint32(endOffset + 16, true);
  const diskNumber = view.getUint16(endOffset + 4, true);
  const directoryDisk = view.getUint16(endOffset + 6, true);
  if (diskNumber !== 0 || directoryDisk !== 0 || diskEntryCount !== entryCount || entryCount === 65535 || directoryBytes === 4294967295 || directoryOffset === 4294967295) {
    failDocument(
      "document_archive_unsupported",
      "Multi-disk and ZIP64 OOXML archives are not supported."
    );
  }
  if (entryCount > MAX_ARCHIVE_ENTRIES) {
    failDocument(
      "document_archive_entry_limit",
      `The OOXML archive exceeds the ${MAX_ARCHIVE_ENTRIES}-entry limit.`
    );
  }
  const directoryEnd = directoryOffset + directoryBytes;
  if (directoryEnd > endOffset || directoryEnd > bytes.byteLength) {
    failDocument("document_archive_invalid", "The OOXML archive is invalid.");
  }
  let offset = directoryOffset;
  let declaredUncompressedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > directoryEnd || view.getUint32(offset, true) !== CENTRAL_DIRECTORY_ENTRY_SIGNATURE) {
      failDocument("document_archive_invalid", "The OOXML archive is invalid.");
    }
    const flags = view.getUint16(offset + 8, true);
    const compressionMethod = view.getUint16(offset + 10, true);
    const compressedBytes = view.getUint32(offset + 20, true);
    const uncompressedBytes = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const entryLength = 46 + nameLength + extraLength + commentLength;
    if (offset + entryLength > directoryEnd || compressedBytes === 4294967295 || uncompressedBytes === 4294967295) {
      failDocument("document_archive_invalid", "The OOXML archive is invalid.");
    }
    if ((flags & 1) !== 0) {
      failDocument(
        "document_archive_unsupported",
        "Encrypted OOXML archive entries are not supported."
      );
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      failDocument(
        "document_archive_unsupported",
        "The OOXML archive uses an unsupported compression method."
      );
    }
    declaredUncompressedBytes += uncompressedBytes;
    if (declaredUncompressedBytes > MAX_ARCHIVE_DECLARED_BYTES) {
      failDocument(
        "document_archive_expansion_limit",
        "The OOXML archive declares more expanded data than the safe parsing limit."
      );
    }
    offset += entryLength;
  }
  if (offset !== directoryEnd) {
    failDocument("document_archive_invalid", "The OOXML archive is invalid.");
  }
  return Object.freeze({
    declaredEntries: entryCount,
    declaredUncompressedBytes
  });
}
async function loadOfficeArchive(bytes) {
  const directory = validateArchiveDirectory(bytes);
  let zip;
  try {
    zip = await import_jszip.default.loadAsync(bytes, { checkCRC32: false });
  } catch {
    failDocument("document_archive_invalid", "The OOXML archive is invalid.");
  }
  return Object.freeze({
    zip,
    directory,
    budget: { expandedXmlBytes: 0, processedXmlEntries: 0 }
  });
}
async function readBoundedXml(entry, budget, signal) {
  if (signal?.aborted) {
    failDocument("document_read_cancelled", "Document reading was cancelled.");
  }
  return new Promise((resolve, reject) => {
    const stream = entry.nodeStream("nodebuffer");
    const chunks = [];
    let entryBytes = 0;
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      stream.removeListener("data", onData);
      stream.removeListener("error", onError);
      stream.removeListener("end", onEnd);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      stream.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onAbort = () => {
      fail(
        new DocumentReaderError(
          "document_read_cancelled",
          "Document reading was cancelled."
        )
      );
    };
    const onData = (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      entryBytes += buffer.byteLength;
      if (entryBytes > MAX_XML_ENTRY_BYTES || budget.expandedXmlBytes + entryBytes > MAX_TOTAL_XML_BYTES) {
        fail(
          new DocumentReaderError(
            "document_archive_expansion_limit",
            "The OOXML document exceeds the safe expanded-text parsing limit."
          )
        );
        return;
      }
      chunks.push(buffer);
    };
    const onError = (error) => fail(error);
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      budget.expandedXmlBytes += entryBytes;
      budget.processedXmlEntries += 1;
      resolve(Buffer.concat(chunks, entryBytes).toString("utf8"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    stream.on("data", onData);
    stream.once("error", onError);
    stream.once("end", onEnd);
  });
}
function archiveMetadata(archive) {
  return Object.freeze({
    declaredEntries: archive.directory.declaredEntries,
    declaredUncompressedBytes: archive.directory.declaredUncompressedBytes,
    processedXmlEntries: archive.budget.processedXmlEntries,
    expandedXmlBytes: archive.budget.expandedXmlBytes,
    limits: Object.freeze({
      maxEntries: MAX_ARCHIVE_ENTRIES,
      maxDeclaredUncompressedBytes: MAX_ARCHIVE_DECLARED_BYTES,
      maxXmlEntryBytes: MAX_XML_ENTRY_BYTES,
      maxExpandedXmlBytes: MAX_TOTAL_XML_BYTES
    })
  });
}

// plugins/document-reader/source/text-accumulator.ts
function normalizeExtractedText(value) {
  return value.replaceAll("\0", "").trim();
}
var BoundedTextAccumulator = class {
  #maxCharacters;
  #parts = [];
  #returnedCharacters = 0;
  #totalCharacters = 0;
  #hasContent = false;
  constructor(maxCharacters = MAX_RETAINED_TEXT_CHARS) {
    this.#maxCharacters = maxCharacters;
  }
  append(value, separator = "\n\n") {
    if (value.length === 0) return;
    const combined = this.#hasContent ? separator + value : value;
    this.#hasContent = true;
    this.#totalCharacters += combined.length;
    const remaining = this.#maxCharacters - this.#returnedCharacters;
    if (remaining <= 0) return;
    const retained = combined.slice(0, remaining);
    this.#parts.push(retained);
    this.#returnedCharacters += retained.length;
  }
  finish(format) {
    return Object.freeze({
      text: this.#parts.join(""),
      textBounds: Object.freeze({
        truncated: this.#totalCharacters > this.#returnedCharacters,
        totalCharacters: this.#totalCharacters,
        returnedCharacters: this.#returnedCharacters,
        omittedCharacters: this.#totalCharacters - this.#returnedCharacters,
        maxCharacters: this.#maxCharacters
      }),
      format
    });
  }
};
function extractedTextResult(value, format = Object.freeze({ kind: "text" })) {
  const accumulator = new BoundedTextAccumulator();
  accumulator.append(normalizeExtractedText(value), "");
  return accumulator.finish(format);
}

// plugins/document-reader/source/ooxml.ts
function decodeCodePoint(value, radix) {
  const parsed = Number.parseInt(value, radix);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 1114111) {
    return "�";
  }
  return String.fromCodePoint(parsed);
}
function decodeXml(value) {
  return value.replace(/&#x([0-9a-f]+);/giu, (_, hex) => decodeCodePoint(hex, 16)).replace(/&#(\d+);/gu, (_, decimal) => decodeCodePoint(decimal, 10)).replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");
}
function extractTextNodes(xml, tag) {
  const values = [];
  const pattern = new RegExp(
    `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
    "giu"
  );
  for (const match of xml.matchAll(pattern)) {
    values.push(decodeXml((match[1] ?? "").replace(/<[^>]+>/gu, "")));
  }
  return values;
}
function numericSuffix(name) {
  return Number(name.match(/(\d+)\.xml$/u)?.[1] ?? Number.MAX_SAFE_INTEGER);
}
function archiveResult(accumulator, archive) {
  return accumulator.finish(
    Object.freeze({
      kind: "archive",
      archive: archiveMetadata(archive)
    })
  );
}
async function extractDocxText(bytes, signal) {
  const archive = await loadOfficeArchive(bytes);
  const names = Object.keys(archive.zip.files).filter(
    (name) => /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/u.test(
      name
    )
  ).sort(
    (left, right) => left === "word/document.xml" ? -1 : right === "word/document.xml" ? 1 : left.localeCompare(right)
  );
  const accumulator = new BoundedTextAccumulator();
  for (const name of names) {
    const entry = archive.zip.file(name);
    if (!entry) continue;
    const xml = await readBoundedXml(entry, archive.budget, signal);
    const normalized = xml.replace(/<w:tab\b[^>]*\/>/giu, "	").replace(/<w:br\b[^>]*\/>/giu, "\n").replace(/<\/w:tc>/giu, "	").replace(/<\/w:p>/giu, "\n");
    const text = normalizeExtractedText(
      decodeXml(
        normalized.replace(/<(?!\/?w:t\b)[^>]+>/giu, "").replace(/<\/?w:t\b[^>]*>/giu, "")
      ).replace(/[ \t]+\n/gu, "\n").replace(/\n{3,}/gu, "\n\n")
    );
    accumulator.append(text);
  }
  return archiveResult(accumulator, archive);
}
async function extractPptxText(bytes, signal) {
  const archive = await loadOfficeArchive(bytes);
  const names = Object.keys(archive.zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name)).sort((left, right) => numericSuffix(left) - numericSuffix(right));
  const accumulator = new BoundedTextAccumulator();
  for (const [index, name] of names.entries()) {
    const entry = archive.zip.file(name);
    if (!entry) continue;
    const xml = await readBoundedXml(entry, archive.budget, signal);
    const content = normalizeExtractedText(
      extractTextNodes(xml, "a:t").filter(Boolean).join("\n")
    );
    accumulator.append(`[Slide ${index + 1}]${content ? `
${content}` : ""}`);
  }
  return archiveResult(accumulator, archive);
}
function cellValue(attributes, body, sharedStrings) {
  const type = attributes.match(/\bt="([^"]+)"/u)?.[1];
  const rawValue = body.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/iu)?.[1];
  if (type === "s" && rawValue !== void 0) {
    const index = Number(rawValue);
    return Number.isSafeInteger(index) && index >= 0 ? sharedStrings[index] ?? rawValue : rawValue;
  }
  if (type === "inlineStr") return extractTextNodes(body, "t").join("");
  return decodeXml(rawValue ?? "");
}
async function extractXlsxText(bytes, signal) {
  const archive = await loadOfficeArchive(bytes);
  const sharedStrings = [];
  const sharedEntry = archive.zip.file("xl/sharedStrings.xml");
  if (sharedEntry) {
    const sharedXml = await readBoundedXml(sharedEntry, archive.budget, signal);
    for (const match of sharedXml.matchAll(
      /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/giu
    )) {
      sharedStrings.push(extractTextNodes(match[1] ?? "", "t").join(""));
    }
  }
  const sheetNames = Object.keys(archive.zip.files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(name)).sort((left, right) => numericSuffix(left) - numericSuffix(right));
  const accumulator = new BoundedTextAccumulator();
  for (const [index, name] of sheetNames.entries()) {
    const entry = archive.zip.file(name);
    if (!entry) continue;
    const xml = await readBoundedXml(entry, archive.budget, signal);
    const rows = [];
    for (const rowMatch of xml.matchAll(
      /<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/giu
    )) {
      const cells = [];
      for (const cellMatch of (rowMatch[1] ?? "").matchAll(
        /<c([^>]*)>([\s\S]*?)<\/c>/giu
      )) {
        cells.push(
          cellValue(cellMatch[1] ?? "", cellMatch[2] ?? "", sharedStrings)
        );
      }
      rows.push(cells.join("	"));
    }
    const content = normalizeExtractedText(rows.join("\n"));
    accumulator.append(`[Sheet ${index + 1}]${content ? `
${content}` : ""}`);
  }
  return archiveResult(accumulator, archive);
}

// plugins/document-reader/source/pdf-process.ts
var import_node_child_process2 = require("node:child_process");

// plugins/document-reader/source/pdf-process-main.ts
var PDF_PROCESS_HEADER_MAX_BYTES = 64 * 1024;
async function pdfProcessMain(parse, maxInputBytes, maxHeaderBytes, maxHeapBytes) {
  console.log = console.warn = console.error = () => void 0;
  try {
    const { heap_size_limit } = require("node:v8").getHeapStatistics();
    if (heap_size_limit > maxHeapBytes) {
      const failure = {
        kind: "failure",
        code: "document_pdf_resource_limit",
        message: "PDF extraction could not establish its memory limit."
      };
      process.stdout.end(JSON.stringify(failure), () => process.exit(0));
      return;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > maxInputBytes + maxHeaderBytes + 1) {
        throw new Error("PDF process input exceeds its limit.");
      }
      chunks.push(chunk);
    }
    const input = Buffer.concat(chunks, size);
    const separator = input.indexOf(10);
    if (separator < 0) throw new Error("Missing PDF process header.");
    if (separator > maxHeaderBytes)
      throw new Error("PDF process header is too large.");
    const bytes = input.subarray(separator + 1);
    if (bytes.length > maxInputBytes)
      throw new Error("PDF process input is too large.");
    const header = JSON.parse(
      input.subarray(0, separator).toString("utf8")
    );
    let result;
    await parse({ ...header, bytes }, (message) => {
      result = message;
    });
    if (!result) throw new Error("PDF parser returned no result.");
    process.stdout.end(JSON.stringify(result), () => process.exit(0));
  } catch {
    process.exit(1);
  }
}

// plugins/document-reader/source/pdf-process.ts
function pdfSemiSpaceLimitMb(youngGenerationMb) {
  const maximum = Math.floor(youngGenerationMb / 3);
  let size = 1;
  while (size * 2 <= maximum) size *= 2;
  return size;
}
function pdfProcessArguments(limits) {
  return [
    "--input-type=commonjs",
    "--max-old-space-size=" + limits.maxOldGenerationSizeMb,
    // V8's young generation uses three semi-spaces; keep it within the existing bound.
    "--max-semi-space-size=" + pdfSemiSpaceLimitMb(limits.maxYoungGenerationSizeMb),
    "--stack-size=" + Math.floor(limits.stackSizeMb * 1024),
    "--eval",
    "(" + pdfProcessMain.toString() + ")(" + runPdfParser.toString() + ", " + MAX_DOCUMENT_BYTES + ", " + PDF_PROCESS_HEADER_MAX_BYTES + ", " + (limits.maxOldGenerationSizeMb + limits.maxYoungGenerationSizeMb) * 1024 * 1024 + ")"
  ];
}
function createPdfExtractionProcess(bytes, pdfParseEntrypoint, limits) {
  const header = Buffer.from(
    JSON.stringify({
      pdfParseEntrypoint,
      limits: {
        maxPages: limits.maxPages,
        pageBatchSize: limits.pageBatchSize,
        maxRetainedCharacters: limits.maxRetainedCharacters,
        maxErrorMessageCharacters: MAX_PDF_ERROR_MESSAGE_CHARS
      }
    }) + "\n"
  );
  if (header.length > PDF_PROCESS_HEADER_MAX_BYTES) {
    throw new Error("PDF process header exceeds its limit.");
  }
  const child = (0, import_node_child_process2.spawn)(process.execPath, pdfProcessArguments(limits), {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdin.write(header);
  child.stdin.end(Buffer.from(bytes));
  return child;
}
function pdfCancellationError() {
  return new DocumentReaderError(
    "document_read_cancelled",
    "Document reading was cancelled."
  );
}
function pdfResourceError(message) {
  return new DocumentReaderError("document_pdf_resource_limit", message);
}
function didPdfProcessExitCleanly(code, signal) {
  if (signal !== null) return false;
  return code === 0;
}
async function extractPdfInProcess(bytes, params) {
  if (params.signal?.aborted) throw pdfCancellationError();
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
    throw new DocumentReaderError(
      "document_file_too_large",
      "The PDF exceeds the input size limit."
    );
  }
  const limits = params.limits ?? PDF_EXTRACTION_LIMITS;
  const child = createPdfExtractionProcess(
    bytes,
    params.pdfParseEntrypoint,
    limits
  );
  const maxResultBytes = limits.maxRetainedCharacters * 6 + 4096;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let resultBytes = 0;
    let failure;
    const stopPdfProcess = (error) => {
      if (failure) return;
      failure = error;
      chunks.length = 0;
      child.stdin.destroy();
      child.kill("SIGKILL");
    };
    const onAbort = () => stopPdfProcess(pdfCancellationError());
    const timeout = setTimeout(
      () => stopPdfProcess(
        pdfResourceError(
          "PDF extraction exceeded the " + limits.timeoutMs + "-millisecond time limit."
        )
      ),
      limits.timeoutMs
    );
    timeout.unref();
    child.stdout.on("data", (chunk) => {
      if (failure) return;
      resultBytes += chunk.length;
      if (resultBytes > maxResultBytes) {
        stopPdfProcess(
          pdfResourceError("PDF extraction exceeded its result size limit.")
        );
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on(
      "error",
      () => stopPdfProcess(
        new Error("PDF extraction process could not receive its input.")
      )
    );
    child.stdout.on(
      "error",
      () => stopPdfProcess(
        new Error("PDF extraction process could not return its result.")
      )
    );
    child.stderr.on(
      "error",
      () => stopPdfProcess(new Error("PDF extraction process stream failed."))
    );
    child.on(
      "error",
      () => stopPdfProcess(
        new DocumentReaderError(
          "document_pdf_process_unavailable",
          "The PDF extraction process could not be started or stopped. Do not retry or bypass this restriction with another tool; ask the user to check system requirements or contact their administrator."
        )
      )
    );
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      params.signal?.removeEventListener("abort", onAbort);
      if (failure) {
        reject(failure);
        return;
      }
      if (!didPdfProcessExitCleanly(code, signal)) {
        reject(new Error("PDF extraction process stopped unexpectedly."));
        return;
      }
      try {
        const message = JSON.parse(
          Buffer.concat(chunks, resultBytes).toString("utf8")
        );
        resolve(documentFromPdfMessage(message, limits));
      } catch (error) {
        if (error instanceof SyntaxError) {
          reject(new Error("PDF extraction process returned invalid data."));
          return;
        }
        reject(error);
      }
    });
    params.signal?.addEventListener("abort", onAbort, { once: true });
    if (params.signal?.aborted) onAbort();
  });
}

// plugins/document-reader/source/pdf.ts
function extractPdfText(bytes, pdfParseEntrypoint, signal) {
  const extract = process.platform === "win32" ? extractPdfInProcess : extractPdfInWorker;
  return extract(bytes, {
    pdfParseEntrypoint,
    ...signal ? { signal } : {}
  });
}

// plugins/document-reader/source/extract.ts
function extractRtfText(source) {
  return source.replace(
    /\\'[0-9a-f]{2}/giu,
    (value) => String.fromCharCode(Number.parseInt(value.slice(2), 16))
  ).replace(/\\[a-z]+-?\d* ?/giu, "").replace(/[{}]/gu, "");
}
async function extractDocumentText(document, bytes, pdfParseEntrypoint, signal) {
  switch (document.mimeType) {
    case "application/pdf":
      return extractPdfText(bytes, pdfParseEntrypoint, signal);
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return extractDocxText(bytes, signal);
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      return extractXlsxText(bytes, signal);
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      return extractPptxText(bytes, signal);
    case "application/json": {
      try {
        const parsed = JSON.parse(
          Buffer.from(bytes).toString("utf8")
        );
        return extractedTextResult(JSON.stringify(parsed, null, 2));
      } catch {
        failDocument(
          "document_content_invalid",
          "The requested JSON document is invalid."
        );
      }
    }
    case "application/rtf":
      return extractedTextResult(
        extractRtfText(Buffer.from(bytes).toString("utf8"))
      );
    case "text/plain":
    case "text/csv":
    case "text/markdown":
      return extractedTextResult(Buffer.from(bytes).toString("utf8"));
  }
}

// plugins/document-reader/source/reader.ts
async function readDocument(document, pdfParseEntrypoint, signal) {
  try {
    const file = await readBoundedRegularFile(document.absolutePath, {
      maxBytes: MAX_DOCUMENT_BYTES,
      rootPath: document.rootPath,
      ...signal ? { signal } : {}
    });
    if (!file.ok) failDocumentRead(file, MAX_DOCUMENT_BYTES);
    const bytes = new Uint8Array(file.bytes);
    return Object.freeze({
      bytes: bytes.byteLength,
      extracted: await extractDocumentText(
        document,
        bytes,
        pdfParseEntrypoint,
        signal
      )
    });
  } catch (error) {
    rethrowDocumentIoError(error);
  }
}

// plugins/document-reader/source/source-resolution.ts
var import_node_path4 = require("node:path");
var SUPPORTED_MIME_TYPES = new Set(
  Object.values(EXTENSION_MIME_TYPES)
);
function supportedMimeType(value) {
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const alias = MIME_TYPE_ALIASES[normalized] ?? normalized;
  return SUPPORTED_MIME_TYPES.has(alias) ? alias : void 0;
}
function mimeTypeFromName(value) {
  return EXTENSION_MIME_TYPES[(0, import_node_path4.extname)(value).toLowerCase()];
}
function attachmentDisplayName(attachment) {
  const candidate = attachment.name?.trim() || attachment.id;
  return import_node_path4.posix.basename(import_node_path4.win32.basename(candidate));
}
function attachmentMimeType(attachment) {
  const displayName = attachmentDisplayName(attachment);
  const mimeType = supportedMimeType(attachment.mimeType) ?? mimeTypeFromName(displayName);
  if (!mimeType) {
    failDocument(
      "document_type_unsupported",
      "The requested attachment has an unsupported document type."
    );
  }
  return mimeType;
}
function resolveAttachment(source, attachments) {
  const exactId = attachments.find((attachment) => attachment.id === source);
  if (exactId) return exactId;
  const byName = attachments.filter((attachment) => attachment.name === source);
  if (byName.length > 1) {
    failDocument(
      "document_attachment_ambiguous",
      "Multiple request attachments share that name; use the attachment id."
    );
  }
  return byName[0];
}
function resolveRuntimePathDocument(rawPath, loadContext, executionContext) {
  const runtimePathResolver = executionContext?.runtimePathResolver ?? loadContext.runtimePathResolver;
  const target = resolvePluginPath({ runtimePathResolver }, rawPath, {
    requirePath: true,
    allowedLocations: ["agent_work", "workspace"]
  });
  const mimeType = mimeTypeFromName(target.logicalPath);
  if (!mimeType) {
    failDocument(
      "document_type_unsupported",
      "Unsupported document format. This reader accepts PDF, DOCX, XLSX, PPTX, TXT, CSV, MD, JSON and RTF. For source code or other text files, use read_one_file or inspect_target when available. Changing source_mode does not change supported formats."
    );
  }
  return Object.freeze({
    kind: "runtime_path",
    absolutePath: target.absolutePath,
    rootPath: target.rootPath,
    displayName: (0, import_node_path4.basename)(target.logicalPath),
    mimeType,
    path: Object.freeze({
      location: target.location,
      logicalPath: target.logicalPath
    })
  });
}
function resolveDocumentReference(params) {
  if (params.sourceMode === "working_path") {
    return resolveRuntimePathDocument(
      params.workingPath,
      params.loadContext,
      params.executionContext
    );
  }
  const attachment = resolveAttachment(
    params.source,
    params.executionContext?.sharedState?.requestAttachments ?? []
  );
  if (!attachment) {
    return resolveRuntimePathDocument(
      params.source,
      params.loadContext,
      params.executionContext
    );
  }
  return Object.freeze({
    kind: "attachment",
    absolutePath: attachment.absolutePath,
    rootPath: params.loadContext.runtimePaths.attachmentsDir,
    attachmentId: attachment.id,
    displayName: attachmentDisplayName(attachment),
    mimeType: attachmentMimeType(attachment)
  });
}

// plugins/document-reader/source/handler.ts
function parseSourceMode(value) {
  if (value === void 0) return "source";
  if (value === "source" || value === "working_path") return value;
  failDocument(
    "document_source_mode_invalid",
    "Document source_mode must be source or working_path."
  );
}
function parseInput(params) {
  const sourceMode = parseSourceMode(params.source_mode);
  const startChar = readBoundedInteger(params.start_char, {
    defaultValue: 0,
    minimum: 0,
    maximum: MAX_START_CHAR,
    name: "start_char"
  });
  const maxChars = readBoundedInteger(params.max_chars, {
    defaultValue: DEFAULT_MAX_CHARS,
    minimum: 1e3,
    maximum: MAX_CHARS,
    name: "max_chars"
  });
  if (sourceMode === "source") {
    const source = readOptionalString(params.source, {
      name: "source",
      maxLength: 4096
    });
    if (!source) {
      failDocument(
        "document_source_required",
        "Document reader requires an attachment id, attachment name, or configured-root path."
      );
    }
    return Object.freeze({ sourceMode, source, startChar, maxChars });
  }
  const workingPath = readOptionalString(params.path, {
    name: "path",
    maxLength: 4096
  });
  if (!workingPath) {
    failDocument(
      "document_path_required",
      "Document reader requires an explicit current-execution path."
    );
  }
  return Object.freeze({ sourceMode, workingPath, startChar, maxChars });
}
function singleLineIdentity(value) {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s{2,}/gu, " ").trim();
  return normalized.length > MAX_IDENTITY_CHARS ? `${normalized.slice(0, MAX_IDENTITY_CHARS - 1)}…` : normalized;
}
function identityLines(document) {
  const displayName = singleLineIdentity(document.displayName);
  return document.kind === "attachment" ? [
    `Document: ${displayName}`,
    `Attachment id: ${singleLineIdentity(document.attachmentId)}`
  ] : [
    `Document: ${displayName}`,
    `Path: ${singleLineIdentity(document.path.logicalPath)}`
  ];
}
function sourceData(document) {
  return document.kind === "attachment" ? Object.freeze({
    sourceKind: "attachment",
    attachmentId: document.attachmentId
  }) : Object.freeze({
    sourceKind: "runtime_path",
    location: document.path.location,
    path: document.path.logicalPath
  });
}
function eventMetadata(document) {
  return document.kind === "runtime_path" ? Object.freeze({ path: document.path.logicalPath }) : void 0;
}
function actionTarget(document) {
  return sanitizeJsonText(
    document.kind === "attachment" ? `attachment:${document.attachmentId}` : document.path.logicalPath
  );
}
function renderWindow(document, text, startChar, endChar, totalCharacters) {
  const hasRemainingText = endChar < totalCharacters;
  const hasCompleteTextCoverage = startChar === 0 && !hasRemainingText;
  return [
    `Coverage: characters ${startChar}-${endChar} of ${totalCharacters}${hasCompleteTextCoverage ? " (complete)" : " (partial)"}`,
    `Returned characters: ${endChar - startChar}; omitted before window: ${startChar}; remaining after window: ${totalCharacters - endChar}.`,
    ...hasRemainingText ? [`Next start_char: ${endChar}`] : [],
    ...identityLines(document),
    `MIME: ${document.mimeType}`,
    "Content:",
    sanitizeJsonText(text.slice(startChar, endChar)) || "[no extractable text]"
  ].join("\n");
}
function selectBoundedWindow(document, text, startChar, requestedEndChar, totalCharacters) {
  let lower = startChar;
  let upper = requestedEndChar;
  let endChar = startChar;
  let rendered = renderWindow(
    document,
    text,
    startChar,
    startChar,
    totalCharacters
  );
  while (lower <= upper) {
    const candidateEnd = lower + Math.floor((upper - lower) / 2);
    const candidate = renderWindow(
      document,
      text,
      startChar,
      candidateEnd,
      totalCharacters
    );
    const withinBounds = candidate.length <= MAX_OUTPUT_CHARS && Buffer.byteLength(JSON.stringify(candidate), "utf8") <= MAX_OUTPUT_JSON_BYTES;
    if (withinBounds) {
      endChar = candidateEnd;
      rendered = candidate;
      lower = candidateEnd + 1;
    } else {
      upper = candidateEnd - 1;
    }
  }
  return Object.freeze({ endChar, rendered });
}
function createDocumentReaderHandler(loadContext) {
  const pdfParseEntrypoint = resolvePdfParseEntrypoint(loadContext.path);
  return async (params, executionContext) => {
    try {
      const input = parseInput(params);
      const document = resolveDocumentReference({
        ...input,
        loadContext,
        executionContext
      });
      const read = await readDocument(
        document,
        pdfParseEntrypoint,
        executionContext?.abortSignal
      );
      const totalCharacters = read.extracted.textBounds.totalCharacters;
      const startChar = Math.min(input.startChar, totalCharacters);
      const requestedEndChar = Math.min(
        read.extracted.text.length,
        startChar + input.maxChars
      );
      const { endChar, rendered } = selectBoundedWindow(
        document,
        read.extracted.text,
        startChar,
        requestedEndChar,
        totalCharacters
      );
      const content = read.extracted.text.slice(startChar, endChar);
      const truncated = endChar < totalCharacters;
      const output = boundText(rendered, {
        maxChars: MAX_OUTPUT_CHARS,
        marker: "\n[document output truncated]"
      });
      const eventMeta = eventMetadata(document);
      return successResult({
        output: output.text,
        producedNewInformation: true,
        actions: [
          {
            type: "inspect_target",
            target: actionTarget(document),
            details: "read_document"
          }
        ],
        data: {
          ...sourceData(document),
          ...eventMeta ? { eventMeta } : {},
          hasData: totalCharacters > 0,
          itemCount: totalCharacters > 0 ? 1 : 0,
          mimeType: document.mimeType,
          inputBytes: read.bytes,
          totalCharacters,
          startChar,
          endChar,
          truncated,
          limits: {
            maxInputBytes: MAX_DOCUMENT_BYTES,
            maxStartChar: MAX_START_CHAR,
            maxWindowChars: MAX_CHARS,
            maxOutputChars: MAX_OUTPUT_CHARS,
            maxOutputJsonBytes: MAX_OUTPUT_JSON_BYTES
          },
          truncation: {
            extractedText: read.extracted.textBounds,
            window: {
              truncated,
              requestedStartChar: input.startChar,
              returnedStartChar: startChar,
              returnedEndChar: endChar,
              returnedCharacters: content.length,
              omittedAfterWindow: Math.max(totalCharacters - endChar, 0)
            },
            output: output.metadata
          },
          extraction: read.extracted.format,
          observationMeta: { kind: "stable_fact", carryPolicy: "always" }
        }
      });
    } catch (error) {
      return documentReaderFailure(error);
    }
  };
}

// plugins/document-reader/source/index.ts
var index_default = defineRuntimePlugin(
  (context) => Object.freeze({
    handlers: Object.freeze({
      document_reader: createDocumentReaderHandler(context)
    })
  })
);
