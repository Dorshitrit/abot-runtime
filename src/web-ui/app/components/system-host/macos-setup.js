import { escapeHtml } from "../../lib/text-format.js";

export function hasMacSetup(snapshot) {
  if (snapshot?.readiness?.ready === true) return false;
  return snapshot?.readiness?.platforms?.includes("macos") === true;
}

export function hasLocalMacSetup(snapshot) {
  if (!hasMacSetup(snapshot)) return false;
  return snapshot.readiness.localSetupAvailable === true;
}

function hasLoopbackRuntimeOrigin(url) {
  if (!["http:", "https:"].includes(url.protocol)) return false;
  if (url.hostname === "localhost") return true;
  if (url.hostname.endsWith(".localhost")) return true;
  if (url.hostname === "[::1]") return true;
  return /^127(?:\.\d{1,3}){3}$/u.test(url.hostname);
}

export function macConnectionCommand(origin) {
  try {
    const url = new URL(origin);
    if (hasLoopbackRuntimeOrigin(url))
      return {
        command: `abot host connect --url '${url.origin.replaceAll("'", "'\\''")}'`,
        needsForwarding: false,
      };
  } catch {
    // A remote or unavailable browser origin cannot identify a local forwarded port.
  }
  return {
    command: "abot host connect --url http://localhost:<forwarded-port>",
    needsForwarding: true,
  };
}

export function macRepairConnectionCommand() {
  return {
    command: "abot host status\nabot host connect --url '<saved-runtime-url>'",
    needsForwarding: false,
  };
}

export function readMacPairingReceipt(receipt) {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(receipt?.code ?? ""))
    throw new Error("The pairing response was invalid. Try again.");
  if (!Number.isFinite(Date.parse(receipt.expiresAt)))
    throw new Error("The pairing response was invalid. Try again.");
  return { code: receipt.code, expiresAt: receipt.expiresAt };
}

export function renderMacSetupAction(snapshot, disabled) {
  if (!hasMacSetup(snapshot)) return "";
  const local = hasLocalMacSetup(snapshot);
  const localLabel = snapshot.paired
    ? "Repair Mac connection"
    : "Connect this Mac";
  const label = local ? localLabel : "Connect a Mac";
  const action = local ? "local" : "manual";
  return `<button type="button" data-system-host-mac="${action}" ${disabled ? "disabled" : ""}>${label}</button>`;
}

export function renderMacSetupNotice(snapshot) {
  if (!hasMacSetup(snapshot)) return "";
  if (!hasLocalMacSetup(snapshot))
    return "<p>On the Mac you want to connect, use an installed ABot CLI in Terminal. The connection starts now and at future sign-ins for that Mac user.</p>";
  const name = snapshot.readiness.localComputerName;
  const computer = name ? ` <strong>${escapeHtml(name)}</strong>` : " this Mac";
  return `<p>Connect${computer} using its installed ABot. This enables the companion now and at future sign-ins for the user running ABot. Allow the macOS permissions requested for desktop access.</p>`;
}

export function renderMacConnectionInstructions(manual) {
  if (!manual) return "";
  const expired =
    manual.expiresAt && Date.parse(manual.expiresAt) <= Date.now();
  const forwarding = manual.needsForwarding
    ? "<p>Use an existing local port forward on the Mac to this Runtime. Replace &lt;forwarded-port&gt; with its localhost port. A remote Runtime address cannot be used directly.</p>"
    : "";
  const pairing =
    manual.code && !expired
      ? `<p>When Terminal asks, paste this one-time code:</p><pre><code>${escapeHtml(manual.code)}</code></pre><p>Code expires at ${escapeHtml(new Date(manual.expiresAt).toLocaleTimeString())}.</p>`
      : "";
  const repair = manual.repair
    ? "<p>On the Mac already paired with ABot, run <code>abot host status</code> first. Replace &lt;saved-runtime-url&gt; in the connect command with the exact saved <code>url</code> shown by status, keeping the quotes. This resumes the saved connection. If this is a different Mac, return to the paired Mac or explicitly unpair before creating a new connection.</p>"
    : "";
  const expiration = expired
    ? "<p>This pairing code expired. Choose Connect a Mac again for a fresh code.</p>"
    : "";
  return `<div class="system-host-manual"><p>Open Terminal on the Mac with ABot installed and run:</p><pre><code>${escapeHtml(manual.command)}</code></pre>${forwarding}${repair}${pairing}${expiration}<p>Return here and wait for Ready after connecting.</p></div>`;
}
