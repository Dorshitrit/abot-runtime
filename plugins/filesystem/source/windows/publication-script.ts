/** Publish the prepared file while its temporary name stays delete-on-close. */
export const WINDOWS_FILESYSTEM_PUBLICATION = String.raw`
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
