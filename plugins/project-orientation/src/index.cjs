// GENERATED FILE - DO NOT EDIT.
// Source: plugins/project-orientation/source/index.ts
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

// plugins/project-orientation/source/index.ts
var index_exports = {};
__export(index_exports, {
  default: () => index_default
});
module.exports = __toCommonJS(index_exports);

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

// plugins/project-orientation/source/inspection-failure.ts
var ProjectInspectionError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "ProjectInspectionError";
  }
  code;
};
function throwIfProjectInspectionCancelled(signal) {
  signal?.throwIfAborted();
}
function isProjectInspectionCancelled(error, signal) {
  if (signal?.aborted) return true;
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return true;
  return "code" in error && error.code === "ABORT_ERR";
}
function failProjectManifestRead(file) {
  if (file.reason === "safe_open_unsupported") {
    throw new ProjectInspectionError(
      "project_safe_read_unavailable",
      "Safe project manifest reading is unavailable on this system. On Windows, computer policy may block the required PowerShell/C# helper. Do not retry or bypass this restriction with another tool; ask the user to check system requirements or contact their administrator."
    );
  }
  if (file.reason === "outside_root") {
    throw new ProjectInspectionError(
      "project_outside_root",
      "The project manifest resolves outside its authorized root. Do not retry this target or bypass the path restriction."
    );
  }
  throw new Error("Project manifest changed while it was being read.");
}
function projectInspectionFailure(error, signal) {
  if (isProjectInspectionCancelled(error, signal)) {
    return failureResult({
      errorCode: "project_inspection_cancelled",
      message: "Project inspection was cancelled.",
      interruption: "aborted"
    });
  }
  if (error instanceof ProjectInspectionError) {
    return failureResult({ errorCode: error.code, message: error.message });
  }
  return failureFromError(error, {
    fallbackCode: "project_orientation_failed",
    fallbackMessage: "Project orientation failed.",
    operation: "inspect_project"
  });
}

// plugins/project-orientation/source/manifest-summary.ts
var import_promises3 = require("node:fs/promises");
var import_node_path4 = require("node:path");
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
  return parent.logicalPath === "." ? name : import_node_path4.posix.join(parent.logicalPath, name);
}
function stringField(record, key) {
  const value = record[key];
  return typeof value === "string" ? sanitizeJsonText(value).slice(0, MANIFEST_IDENTITY_MAX_CHARS) : void 0;
}
function hasTruncatedManifestIdentity(record) {
  return ["name", "version"].some((key) => {
    const value = record[key];
    if (typeof value !== "string") return false;
    return sanitizeJsonText(value).length > MANIFEST_IDENTITY_MAX_CHARS;
  });
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
    const info = await (0, import_promises3.stat)(child.absolutePath);
    return info.isFile() ? child : void 0;
  } catch (error) {
    if (isRuntimeToolPathError(error)) throw error;
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT" || code === "ENOTDIR") return void 0;
    throw error;
  }
}
async function readProjectManifests(context, root, signal) {
  const summaries = [];
  for (const name of KNOWN_MANIFESTS) {
    throwIfProjectInspectionCancelled(signal);
    const target = await existingChild(context, root, name);
    if (!target) continue;
    if (name !== "package.json") {
      summaries.push(Object.freeze({ file: name }));
      continue;
    }
    const file = await readBoundedRegularFile(target.absolutePath, {
      maxBytes: PACKAGE_JSON_MAX_BYTES,
      rootPath: target.rootPath,
      ...signal ? { signal } : {}
    });
    if (!file.ok && file.reason === "too_large") {
      summaries.push(
        Object.freeze({ file: name, status: "too_large" })
      );
      continue;
    }
    if (!file.ok) failProjectManifestRead(file);
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
          ...hasTruncatedManifestIdentity(record) ? { identityTruncated: true } : {},
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
var import_promises4 = require("node:fs/promises");
var import_node_path5 = require("node:path");
var IGNORED_NAMES = /* @__PURE__ */ new Set([".git", "node_modules", "dist", "coverage"]);
var PROJECT_SCAN_ENTRY_LIMIT = 1e3;
function childLogicalPath(parent, childName) {
  return parent.logicalPath === "." ? childName : import_node_path5.posix.join(parent.logicalPath, childName);
}
function relativeEntryPath(root, child) {
  if (child.logicalPath === root.logicalPath) return ".";
  if (root.logicalPath === ".") return child.logicalPath;
  const prefix = `${root.logicalPath}/`;
  return child.logicalPath.startsWith(prefix) ? child.logicalPath.slice(prefix.length) : child.logicalPath;
}
function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
async function collectProjectTree(context, root, depth, signal) {
  const entries = [];
  let scannedEntries = 0;
  const queue = [{ target: root, remainingDepth: depth }];
  while (queue.length > 0) {
    throwIfProjectInspectionCancelled(signal);
    const current = queue.shift();
    if (!current) break;
    const names = [];
    const directory = await (0, import_promises4.opendir)(current.target.absolutePath);
    for await (const entry of directory) {
      throwIfProjectInspectionCancelled(signal);
      scannedEntries += 1;
      if (scannedEntries > PROJECT_SCAN_ENTRY_LIMIT) {
        throw new ProjectInspectionError(
          "project_scan_limit",
          "Project inspection exceeds the 1000-entry scan limit. Use depth 0 or a narrower project path; no complete listing or continuation was produced."
        );
      }
      if (entry.isDirectory() && IGNORED_NAMES.has(entry.name)) continue;
      names.push(entry.name);
    }
    names.sort(compareNames);
    for (const name of names) {
      throwIfProjectInspectionCancelled(signal);
      const child = resolvePluginPath(context, childLogicalPath(current.target, name), {
        requirePath: true,
        allowedLocations: ["agent_work", "workspace"]
      });
      const info = await (0, import_promises4.stat)(child.absolutePath);
      const path = relativeEntryPath(root, child);
      if (info.isDirectory()) {
        entries.push(Object.freeze({ path, kind: "directory" }));
        if (current.remainingDepth > 0) {
          queue.push({ target: child, remainingDepth: current.remainingDepth - 1 });
        }
      } else if (info.isFile()) {
        entries.push(Object.freeze({ path, kind: "file" }));
      }
    }
  }
  throwIfProjectInspectionCancelled(signal);
  return Object.freeze({ entries: Object.freeze(entries), scannedEntries });
}

// plugins/project-orientation/source/project-target.ts
var import_promises5 = require("node:fs/promises");
function isMissingProjectTarget(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
async function readProjectTargetInfo(absolutePath, signal) {
  try {
    return await (0, import_promises5.stat)(absolutePath);
  } catch (error) {
    throwIfProjectInspectionCancelled(signal);
    if (isMissingProjectTarget(error)) {
      throw new ProjectInspectionError(
        "project_target_not_found",
        "The requested project directory does not exist."
      );
    }
    throw error;
  }
}

// plugins/project-orientation/source/page-cursor.ts
var import_node_crypto = require("node:crypto");
var CURSOR_PREFIX = "po1.";
var CURSOR_MAX_CHARS = 512;
var HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
function fingerprint(value) {
  return (0, import_node_crypto.createHash)("sha256").update(JSON.stringify(value)).digest("base64url");
}
function bindProjectPageCursor(target, depth, listing) {
  return Object.freeze({
    query: fingerprint([target.rootPath, target.absolutePath, target.logicalPath, target.location, depth]),
    listing: fingerprint(listing.entries),
    entryCount: listing.entries.length
  });
}
function encodeProjectPageCursor(binding, offset) {
  const payload = { v: 1, q: binding.query, l: binding.listing, o: offset };
  const checked = { ...payload, c: fingerprint(payload) };
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(checked), "utf8").toString("base64url");
}
function invalidCursor() {
  throw new ProjectInspectionError(
    "project_cursor_invalid",
    "The project continuation cursor is invalid. Start a fresh inspection without a cursor."
  );
}
function isCursorRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasSupportedCursorFormat(cursor) {
  if (!cursor.startsWith(CURSOR_PREFIX)) return false;
  return cursor.length <= CURSOR_MAX_CHARS;
}
function isCursorFingerprint(value) {
  if (typeof value !== "string") return false;
  return HASH_PATTERN.test(value);
}
function isContinuationOffset(value) {
  if (typeof value !== "number") return false;
  if (!Number.isSafeInteger(value)) return false;
  return value > 0;
}
function hasValidCursorFields(value) {
  if (!isCursorRecord(value)) return false;
  const hasExactFields = Object.keys(value).sort().join(",") === "c,l,o,q,v";
  if (!hasExactFields) return false;
  if (value.v !== 1) return false;
  if (!isCursorFingerprint(value.q)) return false;
  if (!isCursorFingerprint(value.l)) return false;
  if (typeof value.c !== "string") return false;
  return isContinuationOffset(value.o);
}
function decodeCursor(cursor) {
  if (!hasSupportedCursorFormat(cursor)) invalidCursor();
  const encoded = cursor.slice(CURSOR_PREFIX.length);
  let parsed;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) invalidCursor();
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    invalidCursor();
  }
  if (!hasValidCursorFields(parsed)) invalidCursor();
  const payload = { v: 1, q: parsed.q, l: parsed.l, o: parsed.o };
  const hasMatchingChecksum = parsed.c === fingerprint(payload);
  if (!hasMatchingChecksum) invalidCursor();
  const canonical = CURSOR_PREFIX + Buffer.from(
    JSON.stringify({ ...payload, c: parsed.c }),
    "utf8"
  ).toString("base64url");
  if (canonical !== cursor) invalidCursor();
  return payload;
}
function resolveProjectPageOffset(cursor, binding) {
  if (cursor === void 0) return 0;
  const payload = decodeCursor(cursor);
  const targetsCurrentQuery = payload.q === binding.query;
  if (!targetsCurrentQuery) {
    throw new ProjectInspectionError(
      "project_cursor_query_mismatch",
      "The project cursor belongs to a different target or depth. Start a fresh inspection without a cursor."
    );
  }
  const targetsCurrentListing = payload.l === binding.listing;
  if (!targetsCurrentListing) {
    throw new ProjectInspectionError(
      "project_cursor_stale",
      "The project listing changed. Start a fresh inspection without a cursor."
    );
  }
  if (payload.o >= binding.entryCount) invalidCursor();
  return payload.o;
}

// plugins/project-orientation/source/result-page.ts
var PROJECT_PAGE_ENTRY_LIMIT = 40;
var PROJECT_RESULT_MAX_CHARS = 4e3;
function fitsResultBudget(result) {
  return JSON.stringify(result).length <= PROJECT_RESULT_MAX_CHARS;
}
function hasManifestOmissions(source, projected) {
  return source.some((manifest) => manifest.scriptsTruncated === true || manifest.identityTruncated === true) || JSON.stringify(source) !== JSON.stringify(projected);
}
function pageCandidate(context, entries, manifests) {
  const { input, binding, offset } = context;
  const directories = entries.filter((entry) => entry.kind === "directory").map((entry) => entry.path);
  const files = entries.filter((entry) => entry.kind === "file").map((entry) => entry.path);
  const nextOffset = offset + entries.length;
  const hasMore = nextOffset < input.listing.entries.length;
  const treeTruncated = offset > 0 || hasMore;
  const output = `Project overview: ${directories.length} directories and ${files.length} files in this page. ${hasMore ? "More entries are available using the continuation cursor." : "No further entries in this listing."}`;
  return {
    ok: true,
    output,
    producedNewInformation: true,
    data: {
      location: input.target.location,
      target: input.target.logicalPath,
      depth: input.depth,
      maxEntries: input.maxEntries,
      tree: {
        directories,
        files,
        entries: entries.length,
        truncated: treeTruncated,
        truncatedPathCount: 0,
        sampling: "complete_bounded_directory_scan"
      },
      manifests,
      pagination: {
        hasMore,
        nextCursor: hasMore ? encodeProjectPageCursor(binding, nextOffset) : null
      },
      truncation: {
        output: { truncated: false, originalChars: output.length, returnedChars: output.length, omittedChars: 0 },
        tree: treeTruncated,
        pathCount: 0,
        manifests: hasManifestOmissions(input.manifests, manifests)
      },
      observationMeta: { kind: "volatile_external", carryPolicy: "never" }
    }
  };
}
function replaceManifest(manifests, index, replacement) {
  return manifests.map((manifest, position) => position === index ? replacement : manifest);
}
function fitManifestDetails(context, entries, manifests, index) {
  const source = context.input.manifests[index];
  let projected = manifests;
  for (const field of ["name", "version", "private"]) {
    if (source[field] === void 0) continue;
    const candidate = replaceManifest(projected, index, { ...projected[index], [field]: source[field] });
    if (fitsResultBudget(pageCandidate(context, entries, candidate))) projected = candidate;
  }
  if (!source.scripts) return projected;
  const scripts = [];
  for (const script of source.scripts) {
    const next = [...scripts, script];
    const candidate = replaceManifest(projected, index, {
      ...projected[index],
      scripts: next,
      scriptsTruncated: source.scriptsTruncated === true || next.length < source.scripts.length
    });
    if (!fitsResultBudget(pageCandidate(context, entries, candidate))) break;
    scripts.push(script);
    projected = candidate;
  }
  return projected;
}
function fitManifests(context, entries) {
  let projected = [];
  for (const source of context.input.manifests) {
    const hasOmittedScripts = source.scriptsTruncated === true || (source.scripts?.length ?? 0) > 0;
    const binding = {
      file: source.file,
      ...source.status ? { status: source.status } : {},
      ...source.identityTruncated ? { identityTruncated: true } : {},
      ...hasOmittedScripts ? { scriptsTruncated: true } : {}
    };
    const candidate = [...projected, binding];
    if (!fitsResultBudget(pageCandidate(context, entries, candidate))) break;
    projected = candidate;
  }
  for (let index = 0; index < projected.length; index += 1) {
    const source = context.input.manifests[index];
    const complete = replaceManifest(projected, index, source);
    if (fitsResultBudget(pageCandidate(context, entries, complete))) {
      projected = complete;
      continue;
    }
    projected = fitManifestDetails(context, entries, projected, index);
  }
  return projected;
}
function unrepresentableEntry() {
  return failureResult({
    errorCode: "project_entry_exceeds_budget",
    message: "A complete project path cannot fit within the 4000-character result limit. Inspect a nearer parent with depth 0 or a narrower target; no abbreviated path or continuation was returned."
  });
}
function buildProjectInspectionPage(input) {
  const binding = bindProjectPageCursor(input.target, input.depth, input.listing);
  const offset = resolveProjectPageOffset(input.cursor, binding);
  const context = { input, binding, offset };
  const pageLimit = Math.min(input.maxEntries, PROJECT_PAGE_ENTRY_LIMIT);
  const entries = input.listing.entries.slice(offset, offset + pageLimit);
  while (entries.length > 0 && !fitsResultBudget(pageCandidate(context, entries, []))) {
    entries.pop();
  }
  if (entries.length === 0 && offset < input.listing.entries.length) return unrepresentableEntry();
  if (!fitsResultBudget(pageCandidate(context, entries, []))) return unrepresentableEntry();
  const manifests = fitManifests(context, entries);
  const result = pageCandidate(context, entries, manifests);
  return successResult({ output: result.output, producedNewInformation: true, data: result.data });
}
function boundProjectInspectionFailure(result) {
  if (fitsResultBudget(result)) return result;
  const bounded = failureResult({
    errorCode: result.errorCode ?? "project_orientation_failed",
    message: "Project inspection failed. Error details exceeded the bounded result limit.",
    ...result.interruption ? { interruption: result.interruption } : {}
  });
  if (fitsResultBudget(bounded)) return bounded;
  return failureResult({
    errorCode: "project_orientation_failed",
    message: "Project inspection failed. Error metadata exceeded the bounded result limit.",
    ...result.interruption ? { interruption: result.interruption } : {}
  });
}

// plugins/project-orientation/source/index.ts
var DEFAULT_DEPTH = 0;
var DEFAULT_MAX_ENTRIES = 40;
var MAX_DEPTH = 6;
var MAX_ENTRIES = 250;
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
      async inspect_project(params, executionContext = void 0) {
        const pathContext = {
          ...context,
          runtimePathResolver: executionContext?.runtimePathResolver ?? context.runtimePathResolver
        };
        const signal = executionContext?.abortSignal;
        try {
          throwIfProjectInspectionCancelled(signal);
          const requestedPath = readOptionalString(params.path) ?? ".";
          const target = resolvePluginPath(pathContext, requestedPath, {
            defaultPath: ".",
            allowedLocations: ["agent_work", "workspace"]
          });
          const info = await readProjectTargetInfo(target.absolutePath, signal);
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
          const cursor = readOptionalString(params.cursor, {
            name: "cursor",
            trim: false,
            minLength: 1,
            maxLength: 1024
          });
          const [listing, manifests] = await Promise.all([
            collectProjectTree(pathContext, target, depth, signal),
            readProjectManifests(pathContext, target, signal)
          ]);
          throwIfProjectInspectionCancelled(signal);
          return buildProjectInspectionPage({
            target,
            depth,
            maxEntries,
            cursor,
            listing,
            manifests
          });
        } catch (error) {
          return boundProjectInspectionFailure(projectInspectionFailure(error, signal));
        }
      }
    }
  };
});
