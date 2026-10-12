export const WINDOWS_FILE_READ_BYTES = String.raw`
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
