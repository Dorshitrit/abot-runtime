using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace ABot.Companion.Desktop
{
    internal static class CompanionProcess
    {
        private const int OutputCharacterLimit = 32768;
        private static readonly string PackageDirectory = AppDomain.CurrentDomain.BaseDirectory;

        internal static async Task<Dictionary<string, object>> ReadJson(string command, string input)
        {
            string output = await Run(command, input, 15000);
            var serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = OutputCharacterLimit;
            serializer.RecursionLimit = 12;
            var value = serializer.DeserializeObject(output) as Dictionary<string, object>;
            if (value == null) throw new InvalidOperationException("companion_response_invalid");
            return value;
        }

        internal static Task<string> Setup(string invitation)
        {
            return Run("setup-link", invitation, 60000);
        }

        internal static Task<string> Disconnect()
        {
            return Run("host disconnect", null, 30000);
        }

        internal static Task<string> OpenPluginLink(string link)
        {
            return Run("open-plugin-link", link, 15000);
        }

        internal static void StartBackground()
        {
            using (var process = new Process())
            {
                process.StartInfo = StartInfo("host run", false);
                if (!process.Start()) throw new InvalidOperationException("companion_start_failed");
            }
        }

        private static ProcessStartInfo StartInfo(string command, bool capture)
        {
            string node = Path.Combine(PackageDirectory, "node.exe");
            string entry = Path.Combine(PackageDirectory, "companion.mjs");
            if (!File.Exists(node) || !File.Exists(entry))
                throw new InvalidOperationException("companion_package_incomplete");
            return new ProcessStartInfo
            {
                FileName = node,
                Arguments = QuoteArgument(entry) + " " + command,
                WorkingDirectory = PackageDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardInput = capture,
                RedirectStandardOutput = capture,
                RedirectStandardError = capture,
                StandardOutputEncoding = capture ? new UTF8Encoding(false) : null,
                StandardErrorEncoding = capture ? new UTF8Encoding(false) : null
            };
        }

        private static async Task<string> Run(string command, string input, int timeoutMs)
        {
            using (var process = new Process())
            {
                process.StartInfo = StartInfo(command, true);
                if (!process.Start()) throw new InvalidOperationException("companion_start_failed");
                Task<string> output = ReadBounded(process.StandardOutput, process);
                Task<string> error = ReadBounded(process.StandardError, process);
                Task request = WriteRequestAndWait(process, input);
                Task complete = Task.WhenAll(output, error, request);
                try
                {
                    if (await Task.WhenAny(complete, Task.Delay(timeoutMs)) != complete)
                        throw new TimeoutException("companion_request_timeout");
                    await complete;
                    if (process.ExitCode != 0)
                        throw CompanionHelperError.FromOutput(error.Result);
                    return output.Result;
                }
                finally
                {
                    StopHelper(process);
                    ObserveFailure(complete);
                }
            }
        }

        private static async Task WriteRequestAndWait(Process process, string input)
        {
            // Invitations can contain credentials. They never enter arguments or logs.
            byte[] bytes = Encoding.UTF8.GetBytes(input ?? "");
            await process.StandardInput.BaseStream.WriteAsync(bytes, 0, bytes.Length);
            process.StandardInput.Close();
            await Task.Run(delegate { process.WaitForExit(); });
        }

        private static async Task<string> ReadBounded(StreamReader reader, Process process)
        {
            var text = new StringBuilder();
            var buffer = new char[2048];
            int count;
            while ((count = await reader.ReadAsync(buffer, 0, buffer.Length)) != 0)
            {
                if (text.Length + count > OutputCharacterLimit)
                {
                    StopHelper(process);
                    throw new InvalidOperationException("companion_response_too_large");
                }
                text.Append(buffer, 0, count);
            }
            return text.ToString();
        }

        private static void StopHelper(Process process)
        {
            try { if (!process.HasExited) process.Kill(); }
            catch (InvalidOperationException) { }
            catch (System.ComponentModel.Win32Exception) { }
        }

        private static void ObserveFailure(Task task)
        {
            task.ContinueWith(delegate(Task failed) { var ignored = failed.Exception; },
                TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously);
        }

        private static string QuoteArgument(string value)
        {
            var quoted = new StringBuilder("\"");
            int slashes = 0;
            foreach (char character in value)
            {
                if (character == '\\') { slashes++; continue; }
                if (character == '"')
                {
                    quoted.Append('\\', slashes * 2 + 1).Append(character);
                    slashes = 0;
                    continue;
                }
                quoted.Append('\\', slashes).Append(character);
                slashes = 0;
            }
            return quoted.Append('\\', slashes * 2).Append('"').ToString();
        }

        internal static bool ReadBoolean(Dictionary<string, object> value, string key)
        {
            object field;
            return value.TryGetValue(key, out field) && field is bool && (bool)field;
        }

        internal static string ReadText(Dictionary<string, object> value, string key)
        {
            object field;
            return value.TryGetValue(key, out field) ? field as string : null;
        }
    }
}
