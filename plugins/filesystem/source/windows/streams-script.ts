/** Inspect the held file's stream names without reading their contents. */
export const WINDOWS_FILESYSTEM_STREAMS = String.raw`
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
