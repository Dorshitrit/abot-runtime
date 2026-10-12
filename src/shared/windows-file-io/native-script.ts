/** Windows handle primitives. Trusted source only; request data is passed as JSON. */
export const WINDOWS_FILESYSTEM_NATIVE = String.raw`
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
