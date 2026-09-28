# SYSTEM computer control

SYSTEM can observe and control the user's existing desktop alongside its command,
file and application capabilities. It does not infer task intent, parse shell output
into clicks, select browser brands or create a separate authenticated session.

Enable the SYSTEM plugin and its computer capabilities through the existing plugin
configuration. Ask and Full retain exact-action approvals; Full+ retains its normal
approval policy. OS accessibility, screen-recording and portal permissions still
apply. An available shell or connected companion does not prove desktop readiness.

## Shared connection

Use **Home → Computer access** for one installation shared
with ABot Spark. ABot Spark collection remains a separate opt-in. **Unpair computer**
revokes the connection while retaining saved insights. Native drivers and Companion
lifecycle live in the Runtime's `src/computer-access`, consumed through the optional
computer-access SDK facade; SYSTEM owns tool declarations and request adapters.

Accepted input receipts populate the Runtime's existing mutation-evidence contract
for native input dispatch only. They do not verify navigation, page content or the
user's task outcome. Partial/image failures preserve the accepted input evidence.

## Model operations

- `computer_desktops`: discover request-bound desktops, windows and per-operation
  readiness. Native and companion destinations remain distinct even on the same OS.
- `computer_observe`: capture the visible desktop and bounded accessibility content,
  or a smaller region selected inside the preceding image. Returns a temporary image
  and fresh observation/window references. Occluded content is not recovered.
- `computer_act`: click, move, drag, scroll, type literal text, press an explicit key
  chord or focus an observed window. Each operation requires the current observation,
  consumes that reference and attempts a new observation after dispatch. Input
  references expire after two minutes.

Coordinates are image coordinates; the adapter maps them to its native coordinate
space (physical pixels or logical points). Window/accessibility bounds accompanying
an image use the same image coordinates. Discovery without an image labels its
native coordinate space explicitly. Scroll deltas use signed wheel units:
120 is a conventional notch, positive right/down. Fractional wheel support and the
application’s movement depend on the native backend and user settings.

Input receipts distinguish not dispatched, accepted, partial and unknown. Acceptance
does not prove an application effect. Observed focus, session or geometry drift
rejects an action; concurrent user input can still race with native dispatch. There
is no transactional rollback or automatic replay. A failed post-action screenshot
does not erase the injection receipt.

Within one Runtime process, observation/input on local routes for the same OS share
a queue: native and companion transports may reach the same physical desktop.
Desktop identities remain distinct. Separate Runtime processes and concurrent human
input are not covered by this queue.

## Execution environments

| User desktop | Runtime location | Execution route |
| --- | --- | --- |
| Windows | Native Windows | Native Win32/UIA/PowerShell helper |
| Windows | WSL | Windows executable interop, or the locally paired companion |
| Windows/macOS/Linux | Docker | Companion running in the host graphical login |
| macOS | Native macOS | Native Swift helper |
| Linux X11/Wayland | Native Linux | Native Python helper for that graphical session |

The companion connects to the Runtime's loopback address. Publish a container port
on host loopback for this route. This feature does not enable LAN or Internet control,
copy session credentials into a container or infer that a container desktop is its
host desktop. Update an older companion from the current Runtime bundle if discovery
reports `computer_companion_upgrade_required`.

Windows uses existing PowerShell 5.1/.NET, Win32 input, UI Automation and desktop
capture. Secure/locked desktops and Session 0 are unavailable; integrity restrictions
can reject input. macOS requires macOS 14+, Swift developer tools, Screen Recording
and Accessibility grants. A signed precompiled helper is not bundled in this version.

Linux X11 uses Python 3, native X11/XTest and XRandR libraries (RandR 1.3+), an EWMH window manager and
GI/Gio for session-lock status; structured accessibility requires pyatspi/AT-SPI.
Wayland requires Python GI, the RemoteDesktop/ScreenCast portals,
GStreamer with GstVideo and `pipewiresrc`, and a compatible compositor portal backend.
Stable PipeWire serials are used when provided; a lost stream is never reconnected
or rebound to a reused node ID within the request.
The user selects one monitor per request; there is no portable global window inventory,
focus or accessibility API. Capture requires a provably fresh frame; static streams
can report `linux_pipewire_fresh_frame_unavailable`. Resolution changes invalidate
the session. Linux/macOS scroll inputs require multiples of 120. Missing dependencies/permissions are reported
per capability and are not installed or bypassed automatically. Native text injection
never silently replaces the clipboard; unsupported key mappings fail explicitly.

## Media and lifetime

Images use the generic SDK `context.media.writeImage({ bytes, mimeType })` channel,
separate from textual tool output. References are bound to the exact execution and
request. Supported PNGs are bounded to 10 MiB each, four per result and 64 MiB per
request. Metadata remains within the ordinary tool-result budgets. A companion sends
64 KiB private chunks through the existing bounded local protocol; bytes never enter
model-visible JSON output.

The Runtime stores images in request-owned memory, projects them only to consumers
of the original tool evidence, excludes them from history/provider traces, and
disposes buffers and registered resources at request end or abort. A non-vision
model receives an explicit image-input limitation and can still use available text
observations. Companion frames are erased after transfer, replacement or close;
abandoned native sessions have a bounded idle expiry and close on disconnection.

## Validation boundary

Automated checks use fake providers, helper processes, protocol fixtures and native
source compilation where available. They prove transport, identity, cancellation,
image lifetime and projection invariants. Interactive acceptance on each actual OS,
permission configuration, compositor and provider remains a distinct live check;
unit checks alone do not establish all native integrations work on a user's machine.
The Windows helper has been compiled on Windows; its interactive behavior has not
been exercised. macOS native compilation and interactive Linux/macOS checks remain
unverified in this Windows/WSL development environment.
