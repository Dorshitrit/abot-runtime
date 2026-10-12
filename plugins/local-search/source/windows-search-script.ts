import { WINDOWS_FILESYSTEM_NATIVE } from "../../../src/shared/windows-file-io/native-script.js";
import { WINDOWS_FILESYSTEM_AUTHORITY } from "../../../src/shared/windows-file-io/authority-script.js";

import { WINDOWS_SEARCH_LEASE } from "./windows-search-lease.js";

const SEARCH_COMMAND = String.raw`
public static partial class AbotFilesystem {
  static string QuoteSearchArgument(string value) {
    var quoted = new StringBuilder("\"");
    int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { quoted.Append('\\', slashes * 2 + 1); quoted.Append(c); slashes = 0; continue; }
      quoted.Append('\\', slashes); slashes = 0; quoted.Append(c);
    }
    quoted.Append('\\', slashes * 2); quoted.Append('"');
    return quoted.ToString();
  }
  public static int Search(string input) {
    var json = new JavaScriptSerializer { MaxJsonLength = 2 * 1024 * 1024 };
    try {
      var request = json.Deserialize<Dictionary<string,object>>(input);
      using (var lease = new SearchPathLease(request)) {
        var args = (System.Collections.IEnumerable)request["args"];
        var quoted = new List<string>();
        foreach (object arg in args) quoted.Add(QuoteSearchArgument((string)arg));
        var start = new System.Diagnostics.ProcessStartInfo {
          FileName = Text(request, "command"), Arguments = String.Join(" ", quoted),
          WorkingDirectory = lease.IsFile ? Path.GetDirectoryName(lease.Target) : lease.Target,
          UseShellExecute = false, CreateNoWindow = true,
          RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
        };
        using (var process = System.Diagnostics.Process.Start(start)) {
          process.StandardInput.Close();
          var output = process.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
          var errors = process.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
          process.WaitForExit();
          System.Threading.Tasks.Task.WaitAll(output, errors);
          return process.ExitCode;
        }
      }
    } catch { return 125; }
  }
}
`;

export const WINDOWS_SEARCH_SOURCE = [
  WINDOWS_FILESYSTEM_NATIVE,
  WINDOWS_FILESYSTEM_AUTHORITY,
  WINDOWS_SEARCH_LEASE,
  SEARCH_COMMAND,
].join("\n");
