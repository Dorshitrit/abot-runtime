// GENERATED FILE - DO NOT EDIT.
// Source: plugins/json-inspector/source/index.ts
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

// plugins/json-inspector/source/index.ts
var index_exports = {};
__export(index_exports, {
  default: () => index_default
});
module.exports = __toCommonJS(index_exports);
var import_node_util = require("node:util");

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

// plugins/json-inspector/source/shape.ts
var OBJECT_KEY_LIMIT = 40;
var OBJECT_KEY_MAX_CHARS = 64;
var ARRAY_SAMPLE_SIZE = 3;
var MAX_NODES = 200;
function boundedKey(value) {
  const safeValue = sanitizeJsonText(value);
  if (safeValue.length <= OBJECT_KEY_MAX_CHARS) return safeValue;
  const marker = "...[truncated]";
  return `${safeValue.slice(0, OBJECT_KEY_MAX_CHARS - marker.length)}${marker}`;
}
function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
function summarizeJsonShape(value, maxDepth) {
  let visitedNodes = 0;
  let truncatedNodes = 0;
  let truncatedKeys = 0;
  const visit = (current, depth) => {
    if (visitedNodes >= MAX_NODES) {
      truncatedNodes += 1;
      return `[${valueType(current)} omitted: node budget reached]`;
    }
    visitedNodes += 1;
    if (depth >= maxDepth) {
      if (current !== null && typeof current === "object") truncatedNodes += 1;
      return `[${valueType(current)} at depth limit]`;
    }
    if (Array.isArray(current)) {
      const sampled = current.slice(0, ARRAY_SAMPLE_SIZE);
      if (sampled.length < current.length) truncatedNodes += 1;
      return Object.freeze({
        type: "array",
        length: current.length,
        sampledItems: Object.freeze(
          sampled.map((item) => visit(item, depth + 1))
        ),
        returnedItems: sampled.length,
        truncated: sampled.length < current.length
      });
    }
    if (current && typeof current === "object") {
      const record = current;
      const names = Object.keys(record).sort(
        (left, right) => left.localeCompare(right)
      );
      const returnedNames = names.slice(0, OBJECT_KEY_LIMIT);
      if (returnedNames.length < names.length) truncatedNodes += 1;
      return Object.freeze({
        type: "object",
        totalKeys: names.length,
        returnedKeys: returnedNames.length,
        truncated: returnedNames.length < names.length,
        keys: Object.freeze(
          returnedNames.map((key) => {
            if (key.length > OBJECT_KEY_MAX_CHARS) truncatedKeys += 1;
            return Object.freeze({
              key: boundedKey(key),
              value: visit(record[key], depth + 1)
            });
          })
        )
      });
    }
    return Object.freeze({
      type: "primitive",
      valueType: valueType(current)
    });
  };
  return Object.freeze({
    shape: visit(value, 0),
    metadata: Object.freeze({
      maxDepth,
      maxNodes: MAX_NODES,
      visitedNodes,
      truncatedNodes,
      truncatedKeys,
      arraySampleSize: ARRAY_SAMPLE_SIZE,
      objectKeyLimit: OBJECT_KEY_LIMIT,
      objectKeyMaxChars: OBJECT_KEY_MAX_CHARS
    })
  });
}
function parseJsonErrorPosition(error, source) {
  const message = error instanceof Error ? error.message : "";
  const match = /position\s+(\d+)/iu.exec(message);
  if (!match?.[1]) return void 0;
  const position = Number(match[1]);
  if (!Number.isSafeInteger(position) || position < 0) return void 0;
  const prefix = source.slice(0, position);
  const lineStart = prefix.lastIndexOf("\n");
  return Object.freeze({
    position,
    line: prefix.split("\n").length,
    column: position - lineStart
  });
}

// plugins/json-inspector/source/read-failure.ts
function jsonReadFailure(file, maxBytes) {
  switch (file.reason) {
    case "not_regular_file":
      return failureResult({
        errorCode: "json_target_not_file",
        message: "The requested JSON target is not a regular file."
      });
    case "too_large":
      return failureResult({
        errorCode: "json_file_too_large",
        message: "The requested file exceeds the " + maxBytes + "-byte JSON inspection limit."
      });
    case "outside_root":
      return failureResult({
        errorCode: "json_outside_root",
        message: "The requested file resolves outside its authorized root. Do not retry this target or bypass the path restriction."
      });
    case "safe_open_unsupported":
      return failureResult({
        errorCode: "json_safe_read_unavailable",
        message: "Safe file reading is unavailable on this system. On Windows, computer policy may block the required PowerShell/C# helper. Do not retry or bypass this restriction with another tool; ask the user to check the system requirements or contact their administrator."
      });
    case "changed_during_read":
      return failureResult({
        errorCode: "json_file_changed",
        message: "The requested JSON file changed while it was read."
      });
  }
}

// plugins/json-inspector/source/index.ts
var MAX_FILE_BYTES = 2 * 1024 * 1024;
var MAX_DEPTH = 6;
var OUTPUT_MAX_CHARS = 8e3;
var index_default = defineRuntimePlugin((context) => {
  const defaultDepth = readBoundedInteger(context.config?.defaultDepth, {
    defaultValue: 3,
    minimum: 0,
    maximum: MAX_DEPTH,
    name: "defaultDepth"
  });
  return {
    handlers: {
      async inspect_json(params, executionContext = void 0) {
        const pathContext = {
          ...context,
          runtimePathResolver: executionContext?.runtimePathResolver ?? context.runtimePathResolver
        };
        try {
          const requestedPath = readRequiredString(params.path, "path");
          const target = resolvePluginPath(pathContext, requestedPath, {
            requirePath: true,
            allowedLocations: ["agent_work", "workspace"]
          });
          const file = await readBoundedRegularFile(target.absolutePath, {
            maxBytes: MAX_FILE_BYTES,
            rootPath: target.rootPath,
            signal: executionContext?.abortSignal
          });
          if (!file.ok) return jsonReadFailure(file, MAX_FILE_BYTES);
          let source;
          try {
            source = new import_node_util.TextDecoder("utf-8", { fatal: true }).decode(
              file.bytes
            );
          } catch {
            return failureResult({
              errorCode: "json_invalid_encoding",
              message: "The requested JSON file must contain valid UTF-8 text."
            });
          }
          const maxDepth = readBoundedInteger(params.maxDepth, {
            defaultValue: defaultDepth,
            minimum: 0,
            maximum: MAX_DEPTH,
            name: "maxDepth"
          });
          let parsed;
          try {
            parsed = JSON.parse(source);
          } catch (error) {
            const position = parseJsonErrorPosition(error, source);
            return successResult({
              output: [
                `JSON syntax is invalid: ${target.logicalPath}`,
                position ? `Location: line ${position.line}, column ${position.column}` : "Location: unavailable"
              ].join("\n"),
              producedNewInformation: true,
              data: {
                location: target.location,
                path: target.logicalPath,
                valid: false,
                syntaxValid: false,
                ...position ? { position } : {},
                observationMeta: {
                  kind: "volatile_external",
                  carryPolicy: "never"
                }
              }
            });
          }
          const summary = summarizeJsonShape(parsed, maxDepth);
          const rawOutput = [
            `Valid JSON: ${target.logicalPath}`,
            `Bytes: ${Buffer.byteLength(source, "utf8")}`,
            `Top-level type: ${parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed}`,
            `Structure (depth ${maxDepth}, ${summary.metadata.visitedNodes}/${summary.metadata.maxNodes} nodes):`,
            JSON.stringify(summary.shape, null, 2)
          ].join("\n");
          const bounded = boundText(rawOutput, {
            maxChars: OUTPUT_MAX_CHARS,
            marker: "\n[JSON structure output truncated]"
          });
          return successResult({
            output: bounded.text,
            producedNewInformation: true,
            data: {
              location: target.location,
              path: target.logicalPath,
              valid: true,
              syntaxValid: true,
              maxDepth,
              structure: summary.shape,
              truncation: {
                ...summary.metadata,
                output: bounded.metadata
              },
              observationMeta: {
                kind: "volatile_external",
                carryPolicy: "never"
              }
            }
          });
        } catch (error) {
          const readWasAborted = executionContext?.abortSignal?.aborted && error instanceof Error && error.name === "AbortError";
          if (readWasAborted) {
            return failureResult({
              errorCode: "json_inspection_cancelled",
              message: "JSON inspection was cancelled.",
              interruption: "aborted"
            });
          }
          return failureFromError(error, {
            fallbackCode: "json_inspection_failed",
            fallbackMessage: "JSON inspection failed.",
            operation: "inspect_json"
          });
        }
      }
    }
  };
});
