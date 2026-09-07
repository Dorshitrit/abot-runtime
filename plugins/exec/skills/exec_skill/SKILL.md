# Exec Skill

- Use `exec` for narrow shell-native discovery or verification when a dedicated tool is insufficient.
- `exec` is available on Linux and macOS with executable `/bin/bash`; it does not select a Windows shell or another fallback shell. Commands must use the utilities and options available on the host.
- Resolve `.` and ordinary relative `cwd` values from the configured agent work directory. They are never rewritten to the active Worker working directory. Use `workspace/...` only when the configured workspace is explicitly intended.
- Always provide an explicit existing `cwd`. For an existing project, use its project path. To create a new project, use an existing parent `cwd` (normally `.`) and create the project path in the command.
- The cwd is restricted to configured roots, but the shell runs with the runtime process permissions and is not an operating-system sandbox.
- Keep commands deterministic, non-interactive, and scoped to the selected configured root.
- Availability under full-access mode is not user authorization for sensitive effects. Starting a listener or server, launching a browser or GUI automation, installing software, changing services, or creating long-running background work requires explicit authorization in the current user request.
- For multi-line input, use a single-quoted here-document instead of fragile quoted one-line payloads.
- Prefer an active file creation or editing capability over shell redirection when it can express the requested change.
- If a process remains active, continue the same process with `exec_wait`; do not launch it again.
