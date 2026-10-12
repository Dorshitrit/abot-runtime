export const WINDOWS_FILESYSTEM_WRITE = String.raw`
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
