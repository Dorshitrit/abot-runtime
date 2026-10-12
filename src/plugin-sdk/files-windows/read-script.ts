import { WINDOWS_FILESYSTEM_NATIVE } from "../../shared/windows-file-io/native-script.js";
import { WINDOWS_FILESYSTEM_AUTHORITY } from "../../shared/windows-file-io/authority-script.js";
import { WINDOWS_FILE_READ_BYTES } from "../../shared/windows-file-io/read-bytes-script.js";

const BOUNDED_READ = String.raw`
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

export const WINDOWS_BOUNDED_READ_SOURCE = [
  WINDOWS_FILESYSTEM_NATIVE,
  WINDOWS_FILESYSTEM_AUTHORITY,
  WINDOWS_FILE_READ_BYTES,
  BOUNDED_READ,
].join("\n");
