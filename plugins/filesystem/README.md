# Filesystem plugin

The same four tools run on Linux, macOS and native Windows: `dev_view`,
`read_file`, `write_file` and `edit_file`. Tools use the runtime's existing
authorized `agent_work` and `workspace` roots. This plugin does not grant access
to arbitrary host paths.

`write_file` takes a complete file path, including its filename. Missing parent
directories are created automatically: writing `project/index.html` creates
`project` if needed, while writing `project` creates a file with that name.
To create an empty directory, use an available SYSTEM or EXEC command tool.
Files without extensions, such as `README`, remain valid file targets.
If an intermediate path component is a file, the plugin returns
`not_a_directory` and explains that the path must be corrected before another
attempt. It does not replace or remove the blocking file.

## Native Windows

Windows uses a plugin-owned C# helper compiled by the built-in Windows
PowerShell and .NET Framework. No extra application, administrator elevation,
Companion pairing or execution-policy change is performed. Atomic publication
requires Windows 10 version 1809 or newer and a filesystem supporting hard
links, such as NTFS. Unsupported publication is rejected.

Before tools enter a request's catalog, the plugin verifies that the helper can
compile and run. If PowerShell, compilation or organizational policy blocks it,
the filesystem tools are omitted from that request. A new request checks again.
This availability check does not guarantee permission to every selected file.

If a policy or helper-availability block appears after preparation, the tool
returns a non-retryable error explaining that no file operation ran. Subsequent
filesystem calls in that request return the same block without starting the
helper again. A file-specific access denial does not disable other file tools.
Organizational policy must be resolved by the user's administrator; the plugin
does not bypass it.

Each operation validates the authorized root's identity and opens path
components relative to held directory handles. Reparse points, device names,
alternate data streams and ambiguous Windows path aliases are rejected. Reads
and directory samples remain bounded. Writes use a private temporary file, check
the observed destination before commit, then atomically publish a hard link
under the final name within the held parent directory. New files are restricted
to the current Windows user; replacement preserves the existing file's DACL and
its protection flag. The temporary handle denies other opens until publication,
including while the destination's DACL is copied. The temporary name is marked
delete-on-close at creation and remains marked through publication. Windows
removes that name even if the helper is killed; a successfully published final
name survives independently. Replacing EFS-encrypted, NTFS-compressed or
named-stream-bearing files is rejected without changing the original or its
streams (including download-origin metadata). Reads remain available under the
existing permissions. The tool reports a non-retryable file-specific
restriction; other files remain usable. Writes to case variants of one Windows
path share the same in-process queue. Conflict checks before replacement are
optimistic: a separate process can still change the destination between the last
check and atomic publication. A read-only destination is left unchanged.
Interrupted writes with an unknown outcome are reported explicitly and are never
replayed by the plugin.

The maintained native tests cover Windows file operations, junction redirection,
conflicting writes, DACL preservation, read-only targets and policy blocking.
Network shares and third-party filesystem providers have not been validated.
Providers that lack the required identity or handle operations fail explicitly.

Optional host-generated chat file previews remain subject to the host's Windows
support. Successful plugin reads and writes do not depend on those previews.
