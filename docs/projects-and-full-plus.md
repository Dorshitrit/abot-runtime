# Projects and FULL+

Projects organize conversations around a working folder. FULL+ authorizes
system actions without per-action approval through the existing permission selector. These are independent choices:
a project does not grant system access, and FULL+ does not require a project.

## Projects

Use the folder-plus button on the navigation rail. Choose a folder in the main
conversation area, optionally give the project a name, and select **Create project**.
**Browse** opens an inline folder picker. Navigate to a folder and choose
**Use this folder** to apply it; cancelling the picker preserves the typed path.
The folder browser shows directories on the Runtime computer, which may differ
from the computer running the browser. Absolute folder paths can also be entered.
On WSL, Windows folders must be accessible through the Linux filesystem, such as
a mounted drive. On a native Mac, choose an accessible macOS directory.

Project groups remain above ordinary conversations in the sidebar. Their plus
button opens another conversation in that project. The existing plus button still
creates an ordinary conversation using the configured default working directory.
There is no fixed product limit on the number of projects. Opening or cancelling
the creation form preserves the current conversation and sends no model request.

The Runtime persists projects and each project's conversation binding. A
conversation's selected directory is resolved for its own requests, including
file output previews. Concurrent projects do not modify one another's directory
or the global configuration. Existing conversations are not migrated automatically.
Project deletion, renaming, and moving existing conversations are outside this
initial feature.

## Permission modes

- **Ask** requests approval before each sensitive action, including EXEC and SYSTEM, using the existing tool-approval flow.
- **Full** keeps ordinary tool behavior and also requests approval before each sensitive action. The approval card recommends FULL+ for future actions without those prompts.
- **FULL+** authorizes task-relevant system actions without additional ABot action
  confirmations or another enablement switch. This includes application discovery
  and launching, general commands, service and process management, installation,
  configuration changes, and other operations the target OS supports.

The selector remembers the user's last explicit choice in this browser. New
conversations, including project conversations, start with that saved choice.
Existing conversations retain their own mode; opening one does not change the
last-choice preference. Legacy conversations without a saved mode remain Full,
and missing or unknown preferences never become FULL+. Each submitted or queued
request captures its own mode; a later selection does not change it.
A client connected to a server without advertised FULL+ support rejects the
unsupported request instead of silently downgrading it.

System capabilities are bundled and enabled by default, using the normal
tool/adapter execution path and the same plugin selection rules as other tools.
A disabled plugin or capability is absent from every request mode, including
FULL+: permission never restores an unavailable tool. Existing explicit
allow/deny selections are respected. Plugin changes use the existing Runtime
restart requirement; FULL+ needs no additional enablement step under the default
selection.
Enabled sensitive capabilities, including every EXEC and SYSTEM operation, are available in all three modes. Their declared
`approval="always"` policy uses the existing runtime approval boundary: Ask and
Full wait for approval of the exact prepared action; FULL+ executes without
that prompt. The card shows recorded target, command, working directory and
elevation details. Approving once neither changes the selected mode nor approves
later actions. Rejection, cancellation or an unavailable approval controller
prevents dispatch. A model instruction, project file or tool result cannot select
the request's mode. Direct tool implementations and low-level registry APIs are
trusted host integration APIs; client requests use the normal invocation boundary.

## Trusted shell execution

The EXEC plugin declares sensitivity through the same `approval="always"`
operation policy as SYSTEM. This covers execute, wait and cancel, without a
tool-name branch in core orchestration. An approval applies to that exact action;
it does not authorize later commands, polling or cancellation actions.

After the required approval, EXEC passes the command to the native shell. It
does not scan its text for paths, shell grammar, program operands or sensitive
effects, and it does not block command names. The explicit working directory
must exist and be accessible to the OS user; relative and workspace aliases keep
their existing bases, and absolute host directories are accepted. Project and
file-tool boundaries do not sandbox shell code. Existing file-tool path contracts
remain unchanged. Execution retains non-interactive I/O, process ownership,
cancellation, timeout, output and resource limits.

## Operating-system targets

Native Linux and macOS command execution, application discovery and launch use
the target OS adapters. Windows execution from WSL requires working Windows
interop and an actual Windows process; the Runtime reports an unavailable target
when that transport is missing. It does not pretend that a Linux command ran on
Windows. No product names receive special hardcoded handling.

Target discovery distinguishes the Runtime OS from its host: a Linux Runtime
inside WSL does not make a Windows desktop application a Linux application.
Application discovery reports the sources it searched. A complete scan of those
sources does not prove that an application is absent from the computer. When the
catalog is insufficient, use the available target-native inspection commands to
check installation and executable identity before choosing a launch method.

FULL+ does not manufacture Administrator/root rights or bypass OS authorization.
Required OS prompts, credentials and unavailable permissions are reported through
the action result. A command receipt identifies its observed shell or helper;
an application launch receipt records dispatch. Neither proves that the intended
application started or that a visible window appeared. Verify the requested
outcome with target-native evidence before reporting it as achieved. A matching
filename, an exit code, or an already-running process alone does not prove a new
launch. Command output may contain further evidence, but the adapter does not
independently validate the effects of arbitrary commands.

A project folder is the working context, not a ceiling on approved system operations.
System commands can address resources outside it without changing `workspaceDir`
to `/`. Existing file-tool path contracts remain in effect. This feature does not
claim OS sandboxing, folder locking, or protection against another process running
with the same user's OS authority. Approval controls whether a sensitive
action may start; it does not lower that process's OS permissions.

## Connecting a Docker Runtime to its computer

A Docker Runtime can use applications and commands on its Windows or macOS host
through the optional native host companion. The companion runs as the signed-in
desktop user and connects outbound to the Runtime's published loopback Web UI
address. It does not require a Docker socket, a privileged container, a Windows
drive mount, or WSL interop inside the container. The container remains a separate
Linux target; discovery identifies Docker separately from WSL.

1. Publish the Docker Web UI port on `127.0.0.1` only, and keep the Runtime's data
   directory persistent. In that deployment, set
   `ABOT_WEB_TRUST_LOOPBACK_PUBLISH=1` in the container environment alongside the
   loopback port mapping (for example, `-p 127.0.0.1:5184:5184
   -e ABOT_WEB_TRUST_LOOPBACK_PUBLISH=1`). Open the Web UI using its configured
   hostname and port.
2. In the initial **Computer** step or **Config → Connected computer**, download
   the setup script for the computer running Docker. Open the Windows script, or
   extract the Mac ZIP and open its executable command file, on that computer.
3. The script installs a private, checksum-verified Node runtime and the exact
   companion build supplied by this ABot installation. It pairs automatically
   using a single-use grant valid for 15 minutes, without a copied code or command.
4. The companion saves a private credential and starts now and at future user
   logins. The Web UI polls actual connection readiness. Downloading the script
   alone is not a successful connection; wait for **Ready**.

The publish-trust setting is off by default. Container detection cannot prove
which host interfaces Docker publishes; a `Host: localhost` request is not proof
of local access. Enable this setting only when every published Web UI port is
restricted to host loopback. Do not enable it for LAN/public port mappings or an
untrusted proxy. It permits the local browser and companion to use the published
port when Docker changes the address/port seen inside the container; it does not
add authentication or secure a remotely exposed Web UI. Native and WSL listeners
retain their existing authority checks.

The companion accepts only Runtime addresses resolving to this computer's
loopback interface. Use the Web UI origin displayed in the connection panel,
including its published port. This connection does not expose a remote command
listener on the native host and does not support pairing to a different computer
over the LAN or internet. Downloadable installers currently require a local HTTP
Web UI origin. They do not disable TLS validation for unsupported HTTPS setups.

One computer connection is shared by all Runtime environments belonging to the
same ABot installation. The native user can pair with one installation at a time;
disconnect before connecting another. Existing native macOS operation and Windows
operation through functioning WSL interop do not require this companion. The
setup screen checks those direct paths first. If WSL Windows execution is
unavailable, it offers a Windows interop repair script instead. The script
preserves unrelated `wsl.conf` settings, including `appendWindowsPath`, then
automatically restarts only the selected distribution without a typed confirmation.
Finish active work before opening the file: the restart interrupts all services
in that distribution. If the configuration update fails, no restart occurs.
The script and GUI verify actual Windows execution after the restart.

Host requests use the existing system plugin and the same exact-action approval
flow: Ask and Full request approval; FULL+ does not add a separate ABot prompt.
Connecting a computer never enables a disabled plugin or tool. Requests identify
available operating systems, not connection identifiers. Before each request's
model calls, the system plugin captures native targets and the connected computer;
existing native execution takes precedence, and the companion supplies an OS
missing locally. Disconnected computer targets are absent from both the direct
and delegated model catalogs. The plugin binds the destination internally before
exact-action approval. Changing the pairing or reconnecting while approval is
pending invalidates that action; it is never redirected or replayed on a new
connection. Command working directories use the selected OS's path syntax.
A container project path is not automatically translated to a Windows or Mac
path. OS authorization still applies, and a launch receipt alone is not proof
that a visible application window appeared.

When confirmed Docker or WSL readiness requires setup, Chat shows a small,
dismissible suggestion linking to **Config → Connected computer**. It does not
appear for working native access, unknown status, or an already paired computer.
It reuses the existing readiness state and refreshes on returning to Chat, without
adding a polling loop. Dismissal lasts until the page is reloaded.

Use **Disconnect computer** in the Web UI to revoke the Runtime's pairing and
pending invitations. The connected companion removes its credential after
revocation. Downloaded setup files contain an expiring invitation, so keep them
private and delete them after use. Browser storage retains neither the invitation
nor the persistent credential.

Advanced installations using the ABot CLI can still use `abot host status`,
`abot host disconnect` and `abot host uninstall`. The downloaded installer does
not add a global `abot` command. Its private Node binary and immutable companion
bundle live under `%LOCALAPPDATA%\ABot\HostCompanion` on Windows or
`~/Library/Application Support/ABot/HostCompanion` on Mac; the same CLI operations
can be invoked there as `<node> <companion-bundle> host uninstall`. This removes
the local credential and login registration; use the Web UI to clear Runtime-side
pairing as well. Reconnecting never silently replaces another installation's
saved native connection.

An offline computer is reported as unavailable. The companion reconnects while
the saved pairing remains valid; it never automatically replays an interrupted
system action. Cancellation or revocation attempts to stop an in-flight command,
but effects already performed are not rolled back. If a connection is lost during
execution, inspect the actual host state before trying the action again.

## Validation status

Implementation and validation progress are recorded in the task journal. Native
Mac QA is performed separately with the owner; mocked platform tests are not a
claim that an actual Mac was tested. No release or installation update is implied
by changes in a development worktree.
Native Windows/macOS companion installation, login startup and visible-application
QA remain separate checks on the real desktop systems; Linux protocol and package
tests do not establish those results.
