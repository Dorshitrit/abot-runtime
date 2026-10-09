using System;

namespace ABot.Companion.Desktop
{
    internal sealed class MissingLocalConnectionException : Exception
    {
        internal MissingLocalConnectionException() : base("companion_local_pairing_missing") { }
    }

    internal static class CompanionHelperError
    {
        private const string MissingLocalConnection = "{\"error\":\"companion_local_pairing_missing\"}";

        internal static Exception FromOutput(string output)
        {
            // Only this fixed helper code may influence presentation; never display stderr.
            if (output == null) return new InvalidOperationException("companion_request_failed");
            if (output.Length > 128) return new InvalidOperationException("companion_request_failed");
            if (String.Equals(output.Trim(), MissingLocalConnection, StringComparison.Ordinal))
                return new MissingLocalConnectionException();
            return new InvalidOperationException("companion_request_failed");
        }
    }
}
