# EXEC

EXEC runs trusted, non-interactive commands on the Runtime host. Linux/macOS and WSL use `/bin/bash -lc`; native Windows uses the system Windows PowerShell with no profile or visible console window. Companion routing belongs to SYSTEM.

The existing `exec`, `exec_wait`, and `exec_cancel` operations retain their exact-action approvals, request/session ownership, output cursors, retained output and time limits. Relative directories use the same agent-work root as filesystem; `workspace/...` uses the workspace, and absolute directories keep their explicit meaning. Commands run with the Runtime user's permissions; the directory is not a sandbox.

## Windows process lifetime

Before executing the supplied command, a PowerShell bootstrap compiles an internal C# adapter and attaches the shell to an unnamed Windows Job Object. The shell holds the sole, non-inheritable handle with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; ordinary child processes inherit job membership. Cancellation, time limits and shell exit terminate the group. The adapter does not support escaping background services or elevate privileges.

The command is sent over closed stdin, so multiline text and the full command limit do not depend on Windows command-line length. Output is UTF-8 and uses the existing retained-output path. Native program exit codes are preserved. PowerShell script execution policies are never changed or bypassed.

If language policy, compilation or job setup blocks startup, the command never runs and the returned diagnostic tells the model not to retry or bypass the restriction. The user or administrator must restore helper availability. The adapter requires no separate installation.

No live process is persisted or replayed during request restoration. The existing terminal-output snapshot remains the only saved execution state. A Job Object is process-local and ends with its owning shell.

Output metadata is written to a synced temporary file and atomically renamed on every platform. Unix also syncs the parent directory; Node does not support that directory sync on Windows, so directory-entry durability across sudden power loss is not guaranteed there. Write, file-sync and rename errors remain failures.

Filesystem change summaries on Windows use non-following file metadata (size and modification time). They do not read file contents for hashing, because Node has no Windows `O_NOFOLLOW`; a same-size edit that preserves the modification time can be unobserved. Command output and exit status are still reported. Linux/macOS retain bounded content hashing.
