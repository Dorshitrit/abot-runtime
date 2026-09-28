import { escapeHtml } from "../../lib/text-format.js";

function hasManagedMacPermissionRuntime(version) {
  if (!Number.isInteger(version)) return false;
  return version >= 6;
}

export function macCompanionPermissionPath(snapshot) {
  if (!snapshot?.paired) return "";
  if (snapshot.identity?.os !== "macos") return "";
  if (!hasManagedMacPermissionRuntime(snapshot.companion?.installedVersion))
    return "";
  const home = snapshot.identity.homeDir;
  const prefix =
    typeof home === "string" && home.startsWith("/")
      ? home.replace(/\/+$/u, "")
      : "~";
  return prefix + "/.abot/host-companion/runtime/node";
}

/** The managed companion keeps its macOS permission subject at one private path. */
export function renderMacPermissionGuide(snapshot) {
  if (!snapshot?.paired) return "";
  if (snapshot.identity?.os !== "macos") return "";
  const version = snapshot.companion?.installedVersion;
  if (!hasManagedMacPermissionRuntime(version))
    return '<p class="system-host-note">Update the Mac connection to set up Spark permissions for its dedicated companion runtime.</p>';
  return `<details class="system-host-manual" data-system-host-mac-permissions>
    <summary>macOS permissions for Spark</summary>
    <p>The connection is ready independently of macOS permission to read activity. Start collection in Spark to request Accessibility access.</p>
    <p>On the connected Mac, open System Settings → Privacy &amp; Security → Accessibility (Device Control &amp; Data Access on some macOS versions). Use the add button, press Command–Shift–G and select this companion executable:</p>
    <pre><code>${escapeHtml(macCompanionPermissionPath(snapshot))}</code></pre>
    <p>macOS may display it as node. Check its path before enabling access. This private runtime belongs to the ABot companion and is reused at sign-in.</p>
    <p>Spark checks for approval for up to two minutes without collecting content. After that, stop and start collection to check again. A runtime replacement can require consent again.</p>
  </details>`;
}
