import { WINDOWS_FILE_READ_BYTES } from "../../../../src/shared/windows-file-io/read-bytes-script.js";
import { WINDOWS_FILESYSTEM_NATIVE } from "./native-script.js";
import { WINDOWS_FILESYSTEM_AUTHORITY } from "./authority-script.js";
import { WINDOWS_FILESYSTEM_READ } from "./read-script.js";
import { WINDOWS_FILESYSTEM_STREAMS } from "./streams-script.js";
import { WINDOWS_FILESYSTEM_STORAGE } from "./storage-script.js";
import { WINDOWS_FILESYSTEM_PUBLICATION } from "./publication-script.js";
import { WINDOWS_FILESYSTEM_WRITE } from "./write-script.js";

const ENTRYPOINT = String.raw`
public static partial class AbotFilesystem {
  public static string Run(string input) {
    var json=new JavaScriptSerializer { MaxJsonLength=2097152 };
    try {
      var request=json.Deserialize<Dictionary<string,object>>(input);
      string operation=Text(request, "operation");
      object result;
      switch (operation) {
        case "probe": result=Record("available", true); break;
        case "read": result=ReadSlices(request); break;
        case "sample": result=SampleDirectory(request); break;
        case "write": result=CommitWrite(request); break;
        default: throw new FsFault("filesystem_invalid_request");
      }
      return json.Serialize(Record("ok", true, "result", result));
    } catch (FsFault error) { return json.Serialize(Record("ok", false, "code", error.Code)); }
      catch { return json.Serialize(Record("ok", false, "code", "filesystem_native_operation_failed")); }
  }
}
`;

export const WINDOWS_FILESYSTEM_SOURCE = [
  WINDOWS_FILESYSTEM_NATIVE,
  WINDOWS_FILESYSTEM_AUTHORITY,
  WINDOWS_FILE_READ_BYTES,
  WINDOWS_FILESYSTEM_READ,
  WINDOWS_FILESYSTEM_STREAMS,
  WINDOWS_FILESYSTEM_STORAGE,
  WINDOWS_FILESYSTEM_PUBLICATION,
  WINDOWS_FILESYSTEM_WRITE,
  ENTRYPOINT,
].join("\n");
