/** Replacement must not silently remove per-file Windows storage properties. */
export const WINDOWS_FILESYSTEM_STORAGE = String.raw`
public static partial class AbotFilesystem {
  static void RequireReplaceableStorage(SafeFileHandle file) {
    const uint encrypted=0x4000, compressed=0x800;
    if ((Basic(file).Attributes & (encrypted | compressed)) != 0)
      throw new FsFault("filesystem_storage_attributes_unsupported");
    RequireUnnamedDataStreamOnly(file);
  }
}
`;
