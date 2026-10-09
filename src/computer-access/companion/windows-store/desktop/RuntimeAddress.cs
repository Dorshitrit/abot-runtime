using System;
using System.Net;

namespace ABot.Companion.Desktop
{
    internal static class RuntimeAddress
    {
        internal static string BrowserOrigin(string value)
        {
            Uri address;
            if (String.IsNullOrWhiteSpace(value)) return null;
            if (!Uri.TryCreate(value, UriKind.Absolute, out address)) return null;
            if (!String.IsNullOrEmpty(address.UserInfo)) return null;
            if (!String.IsNullOrEmpty(address.Fragment)) return null;
            string scheme = BrowserScheme(address);
            if (scheme == null) return null;
            var origin = new UriBuilder(scheme, address.DnsSafeHost, address.Port);
            return origin.Uri.GetLeftPart(UriPartial.Authority);
        }

        private static bool IsLoopbackOrigin(Uri address)
        {
            if (address.IsLoopback) return true;
            if (address.DnsSafeHost.EndsWith(".localhost", StringComparison.OrdinalIgnoreCase)) return true;
            IPAddress ip;
            if (!IPAddress.TryParse(address.DnsSafeHost.Trim('[', ']'), out ip)) return false;
            if (IPAddress.IsLoopback(ip)) return true;
            if (!ip.IsIPv4MappedToIPv6) return false;
            return IPAddress.IsLoopback(ip.MapToIPv4());
        }

        private static string BrowserScheme(Uri address)
        {
            if (address.Scheme == "https" || address.Scheme == "wss") return "https";
            if (!IsLoopbackOrigin(address)) return null;
            if (address.Scheme == "http" || address.Scheme == "ws") return "http";
            return null;
        }
    }
}
