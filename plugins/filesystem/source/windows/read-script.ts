export const WINDOWS_FILESYSTEM_READ = String.raw`
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
