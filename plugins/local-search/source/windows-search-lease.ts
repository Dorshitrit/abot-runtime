// The external search program uses paths, so pin every ancestor from the volume
// root. The ordinary SDK reader instead reads through handles relative to its root.
export const WINDOWS_SEARCH_LEASE = String.raw`
public static partial class AbotFilesystem {
  sealed class SearchPathLease : IDisposable {
    readonly List<SafeFileHandle> held = new List<SafeFileHandle>();
    public readonly string Target;
    public readonly bool IsFile;
    public SearchPathLease(Dictionary<string,object> request) {
      try {
        Target = Path.GetFullPath(Text(request, "targetPath"));
        string root = Path.GetFullPath(Text(request, "rootPath")).TrimEnd('\\');
        if (!String.Equals(Target.TrimEnd('\\'), root, StringComparison.OrdinalIgnoreCase) &&
            !Target.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase))
          throw new FsFault("filesystem_invalid_path");
        IsFile = (bool)request["isFile"];
        string current = Path.GetPathRoot(Target);
        var handle = OpenHandle(null, NativePath(current), true, 1, 0x80000000, 3);
        held.Add(handle);
        bool foundRoot = VerifyRoot(current, root, handle, request);
        string rest = Target.Substring(current.Length).TrimEnd('\\');
        string[] parts = rest.Length == 0 ? new string[0] : rest.Split('\\');
        for (int i = 0; i < parts.Length; i++) {
          ValidateComponent(parts[i]);
          bool isFile = IsFile && i == parts.Length - 1;
          handle = OpenHandle(handle, parts[i], !isFile, 1, 0x80000000, isFile ? 1u : 3u);
          held.Add(handle);
          current = Path.Combine(current, parts[i]);
          if (!String.Equals(FinalPath(handle).TrimEnd('\\'), current.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
            throw new FsFault("filesystem_path_changed");
          foundRoot |= VerifyRoot(current, root, handle, request);
        }
        if (!foundRoot || !MatchesIdentity(Identity(handle), request["targetIdentity"] as Dictionary<string,object>))
          throw new FsFault("filesystem_path_changed");
      } catch { Dispose(); throw; }
    }
    static bool VerifyRoot(string current, string root, SafeFileHandle handle, Dictionary<string,object> request) {
      if (!String.Equals(current.TrimEnd('\\'), root, StringComparison.OrdinalIgnoreCase)) return false;
      var expected = request["rootIdentity"] as Dictionary<string,object>;
      if (expected == null || !MatchesIdentity(Identity(handle), expected)) throw new FsFault("filesystem_path_changed");
      return true;
    }
    public void Dispose() {
      for (int i = held.Count - 1; i >= 0; i--) held[i].Dispose();
      held.Clear();
    }
  }
}
`;
