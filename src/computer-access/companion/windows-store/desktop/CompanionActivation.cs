using System;

namespace ABot.Companion.Desktop
{
    internal static class CompanionActivation
    {
        private const string OpenLink = "abot-companion://open";

        internal static bool IsOpenLink(string value)
        {
            return String.Equals(value, OpenLink, StringComparison.Ordinal);
        }

        internal static string Read(string[] args)
        {
            if (args.Length == 0) return null;
            if (args.Length != 1) throw new InvalidOperationException("activation_arguments_invalid");
            string value = args[0];
            if (value.Length > 16384) throw new InvalidOperationException("activation_length_invalid");
            if (IsOpenLink(value)) return value;
            Uri activation;
            if (!Uri.TryCreate(value, UriKind.Absolute, out activation))
                throw new InvalidOperationException("activation_uri_invalid");
            if (activation.Scheme == "abot") return value;
            if (activation.Scheme != "abot-companion")
                throw new InvalidOperationException("activation_scheme_invalid");
            if (activation.Host != "connect")
                throw new InvalidOperationException("activation_target_invalid");
            // Connection invitations retain the shared Node validation path.
            return value;
        }
    }
}
